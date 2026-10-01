// SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0
// Modified adaptation of Anthropic trace_rules.py, Apache-2.0, ab024cdc.
import { basename, extname, join, relative } from "node:path";
import { workspacePath } from "../../../lib/files.ts";
import {
  content,
  isTooling,
  kind,
  list,
  object,
  text,
  walk,
} from "./common.ts";
import { readEvidence } from "./evidence.ts";
export interface Rule {
  id: string;
  name: string;
  priority: string;
  confidence: string;
  source: string;
}
export function mentions(body: string): { id: string; at: number }[] {
  const found: { id: string; at: number }[] = [];
  for (
    const match of body.matchAll(
      /(?:\brule[-_](\d{1,6})(?!\d)|\brule(\d{3,6})(?!\d)|(?<=[a-z])Rule[-_]?(\d{3,6})(?!\d))/gi,
    )
  ) {
    const id = Number(match[1] ?? match[2] ?? match[3]);
    found.push({ id: `RULE-${String(id).padStart(3, "0")}`, at: match.index });
    const suffix = body.slice(match.index + match[0].length);
    const more = /^(?:\/|,\s*-)(\d{2,6})(?!\d)/;
    let rest = suffix, additional: RegExpExecArray | null;
    while ((additional = more.exec(rest))) {
      found.push({
        id: `RULE-${String(Number(additional[1])).padStart(3, "0")}`,
        at: match.index,
      });
      rest = rest.slice(additional[0].length);
    }
  }
  return found;
}
export function parseRules(body: string): Rule[] {
  const rules: Rule[] = [], ids = new Set<string>();
  let current: Rule | undefined, fence = "";
  for (const line of body.replace(/\r\n?/g, "\n").split("\n")) {
    const f = /^\s{0,3}(`{3,}|~{3,})/.exec(line);
    if (f) {
      if (!fence) fence = f[1];
      else if (f[1][0] === fence[0] && f[1].length >= fence.length) fence = "";
      continue;
    }
    if (fence) continue;
    const heading = /^#{2,5}\s+RULE[-_](\d{1,6})\s*:\s*(.*)$/i.exec(line);
    if (heading) {
      const id = `RULE-${String(Number(heading[1])).padStart(3, "0")}`;
      if (ids.has(id)) throw new Error("Duplicate rule card");
      ids.add(id);
      current = {
        id,
        name: heading[2],
        priority: "",
        confidence: "",
        source: "",
      };
      rules.push(current);
    } else if (/^#{1,6}\s/.test(line)) current = undefined;
    else if (current) {
      const field = /^\s*\*\*(Priority|Confidence|Source):\*\*\s*(.*)$/i.exec(
        line,
      );
      if (field) {
        const key = field[1].toLowerCase() as
          | "priority"
          | "confidence"
          | "source";
        current[key] = field[2].replace(/^`|`$/g, "");
      }
    }
  }
  if (rules.length > 2000) throw new Error("Too many rules");
  if (rules.some((r) => !/^P[012]$/.test(r.priority))) {
    throw new Error(
      "Rule cards must declare recognized priorities; unrated rules cannot establish proof",
    );
  }
  return rules;
}
export async function traceRules(root: string, value: unknown) {
  const spec = object(value),
    rules = parseRules(await content(root, text(spec.rules))),
    modules = list(spec.modules, 100);
  const rows = rules.map((rule) => ({
    ...rule,
    main: [] as string[],
    tests: [] as string[],
    executed: [] as string[],
    claimed: [] as string[],
    namedNotRun: [] as string[],
    status: "none",
  }));
  const perModule: {
    name: string;
    rules: typeof rows;
    toolingOnly: boolean;
  }[] = [];
  for (const item of modules) {
    const mod = object(item), name = text(mod.name), code = text(mod.path);
    const codeRoot = await workspacePath(root, code),
      prefix = relative(root, codeRoot) + "/";
    const selected = (await walk(codeRoot)).map((p) =>
      join(relative(root, codeRoot), p)
    );
    if (!selected.length) throw new Error(`Module has no files: ${name}`);
    const evidence = await readEvidence(root, mod.results ?? []),
      moduleRows = rules.map((rule) => ({
        ...rule,
        main: [] as string[],
        tests: [] as string[],
        executed: [] as string[],
        claimed: [] as string[],
        namedNotRun: [] as string[],
        status: "none",
      }));
    for (const file of selected) {
      const fileKind = kind(file);
      if (fileKind === "doc") continue;
      const body = await content(root, file),
        lines = body.split("\n"),
        stem = basename(file, extname(file)).toLowerCase();
      const associated = evidence.cases.filter((t) =>
        t.id.split("#")[0].split(/[.$:/\\]/).some((k) =>
          k.toLowerCase() === stem
        )
      );
      const backed = evidence.perTest && associated.length > 0 &&
        associated.every((t) => t.outcome === "PASS");
      for (
        const hit of mentions(body).concat(
          mentions(basename(file)).map((h) => ({ ...h, at: -1 })),
        )
      ) {
        const row = moduleRows.find((r) => r.id === hit.id);
        if (!row) continue;
        const line = hit.at < 0 ? 0 : body.slice(0, hit.at).split("\n").length;
        const where = `${file}:${line}`;
        if (fileKind === "main") row.main.push(where);
        else {
          row.tests.push(where);
          const skipped = hit.at >= 0 &&
            lines.slice(Math.max(0, line - 4), line).some((l) =>
              /@Disabled|@Ignore|\[Ignore\]|#\[ignore\]|xit\(|xdescribe|\bskip\b|pending|todo/i
                .test(l)
            );
          if (backed && !skipped) row.executed.push(where);
          else row.namedNotRun.push(where);
        }
      }
    }
    for (const test of evidence.cases) {
      if (test.outcome === "PASS") {
        for (const hit of mentions(test.id)) {
          moduleRows.find((r) => r.id === hit.id)?.executed.push(test.id);
        }
      }
    }
    if (mod.notes !== undefined) {
      let retired = false;
      for (const line of (await content(root, text(mod.notes))).split("\n")) {
        if (line.startsWith("#")) {
          retired =
            /not migrated|not implemented|removed|retired|dropped|out of scope/i
              .test(line);
        }
        if (
          !retired && line.trim().startsWith("|") && selected.some((f) =>
            line.includes(f) || line.includes(f.slice(prefix.length))
          )
        ) {
          for (const hit of mentions(line)) {
            moduleRows.find((r) => r.id === hit.id)?.claimed.push(
              text(mod.notes),
            );
          }
        }
      }
    }
    for (const row of moduleRows) {
      row.status = row.executed.length
        ? "tested"
        : row.tests.length
        ? "named, not run"
        : row.main.length
        ? "code only"
        : row.claimed.length
        ? "claimed only"
        : "none";
      const aggregate = rows.find((r) => r.id === row.id)!;
      for (
        const key of [
          "main",
          "tests",
          "executed",
          "claimed",
          "namedNotRun",
        ] as const
      ) aggregate[key].push(...row[key]);
    }
    const toolingOnly = selected.some((f) => kind(f) === "test") &&
      selected.every((f) => kind(f) !== "main" || isTooling(f));
    perModule.push({ name, rules: moduleRows, toolingOnly });
  }
  for (const row of rows) {
    row.status = row.executed.length
      ? "tested"
      : row.tests.length
      ? "named, not run"
      : row.main.length
      ? "code only"
      : row.claimed.length
      ? "claimed only"
      : "none";
  }
  return {
    ok: rows.length > 0 &&
      rows.filter((r) => /^P0\b/.test(r.priority)).every((r) =>
        r.status === "tested"
      ),
    rules: rows,
    modules: perModule,
    gaps: rows.filter((r) => /^P0\b/.test(r.priority) && r.status !== "tested")
      .map((r) => r.id),
  };
}

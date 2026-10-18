// SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0
// Modified adaptation of Anthropic baseline_diff.py/proof_pack.py, Apache-2.0, ab024cdc.
import { lstat } from "node:fs/promises";
import { decodeUtf8, readWorkspaceFile } from "../../../lib/files.ts";
import { list, object, text } from "./common.ts";
export type Outcome = "PASS" | "FAIL" | "ERROR" | "SKIP";
export interface TestCase {
  id: string;
  outcome: Outcome;
  reason: string;
}
export interface Counts {
  passed: number;
  failed: number;
  skipped: number;
  executed: number;
}
export interface Evidence {
  cases: TestCase[];
  counts: Counts;
  oldest: number;
  sources: string[];
  perTest: boolean;
}
export function tally(cases: TestCase[]): Counts {
  const c = { passed: 0, failed: 0, skipped: 0, executed: 0 };
  for (const t of cases) {
    if (t.outcome === "PASS") c.passed++;
    else if (t.outcome === "SKIP") c.skipped++;
    else c.failed++;
  }
  c.executed = c.passed + c.failed;
  return c;
}
function decode(value: string): string {
  if (
    /[<\uFFFE\uFFFF]|(?![\t\r\n\u0080-\u009f])\p{Cc}/u.test(value) ||
    value.includes("]]>")
  ) throw new Error("Invalid XML text");
  return value.replace(/&([^;]*);|&/g, (whole, name: string | undefined) => {
    const predefined: Record<string, string> = {
      amp: "&",
      lt: "<",
      gt: ">",
      quot: '"',
      apos: "'",
    };
    if (name && Object.hasOwn(predefined, name)) return predefined[name];
    if (name && /^#(?:\d+|x[0-9a-fA-F]+)$/.test(name)) {
      const n = name[1] === "x"
        ? parseInt(name.slice(2), 16)
        : Number(name.slice(1));
      if (
        n === 9 || n === 10 || n === 13 ||
        n >= 32 && n <= 0x10ffff && !(n >= 0xd800 && n <= 0xdfff) &&
          n !== 0xfffe && n !== 0xffff
      ) return String.fromCodePoint(n);
    }
    throw new Error(`Unrecognized XML entity: ${whole}`);
  });
}
export function parseXML(raw: string): TestCase[] {
  if (/<!DOCTYPE|<!ENTITY/i.test(raw)) {
    throw new Error("DTD and entities are forbidden");
  }
  const stack: string[] = [],
    suites: string[] = [],
    cases: TestCase[] = [],
    duplicates: Record<string, number> = Object.create(null);
  const suiteCounts: { from: number; declared: Record<string, string> }[] = [];
  let current: TestCase | undefined, pos = 0, root = "", closed = false;
  const append = (test: TestCase): void => {
    if (cases.length >= 100000) throw new Error("Too many XML test cases");
    const n = duplicates[test.id] ?? 0;
    duplicates[test.id] = n + 1;
    cases.push({ ...test, id: n ? `${test.id}~${n}` : test.id });
  };
  while (pos < raw.length) {
    if (raw[pos] !== "<") {
      const end = raw.indexOf("<", pos),
        body = raw.slice(pos, end < 0 ? raw.length : end);
      decode(body);
      if (!stack.length && body.trim()) {
        throw new Error("Text outside XML root");
      }
      pos += body.length;
      continue;
    }
    if (raw.startsWith("<!--", pos)) {
      const end = raw.indexOf("-->", pos + 4);
      if (end < 0 || raw.slice(pos + 4, end).includes("--")) {
        throw new Error("Malformed XML comment");
      }
      pos = end + 3;
      continue;
    }
    if (raw.startsWith("<![CDATA[", pos)) {
      const end = raw.indexOf("]]>", pos + 9);
      if (end < 0 || !stack.length) throw new Error("Malformed CDATA");
      pos = end + 3;
      continue;
    }
    if (raw.startsWith("<?xml", pos)) {
      const end = raw.indexOf("?>", pos);
      if (
        pos !== 0 || end < 0 ||
        !/^<\?xml\s+version=["']1\.[01]["'](?:\s+encoding=["']UTF-8["'])?(?:\s+standalone=["'](?:yes|no)["'])?\s*\?>$/i
          .test(raw.slice(pos, end + 2))
      ) throw new Error("Malformed XML declaration");
      pos = end + 2;
      continue;
    }
    const match = /^<\/?[A-Za-z_][\w:.-]*(?:\s+[^<>]*?)?\s*\/?>/.exec(
      raw.slice(pos),
    );
    if (!match) throw new Error("Malformed XML tag");
    const token = match[0],
      close = token.startsWith("</"),
      self = token.endsWith("/>"),
      tag = /^<\/?([\w:.-]+)/.exec(token)![1];
    const local = tag.split(":").at(-1)!;
    if (close && !/^<\/[\w:.-]+\s*>$/.test(token)) {
      throw new Error("Malformed closing XML tag");
    }
    if (!close) {
      if (!stack.length) {
        if (root || closed) throw new Error("Multiple XML roots");
        root = local;
        if (!["testsuite", "testsuites", "TestRun"].includes(root)) {
          throw new Error("Unrecognized test evidence root");
        }
      }
      const allowed = root === "TestRun"
        ? [
          "TestRun",
          "Times",
          "TestSettings",
          "Deployment",
          "Execution",
          "Results",
          "UnitTestResult",
          "Output",
          "StdOut",
          "StdErr",
          "ErrorInfo",
          "Message",
          "StackTrace",
          "TestDefinitions",
          "UnitTest",
          "TestMethod",
          "TestLists",
          "TestList",
          "TestEntries",
          "TestEntry",
          "ResultSummary",
          "Counters",
          "RunInfos",
          "RunInfo",
          "CollectorDataEntries",
          "Collector",
          "UriAttachments",
          "UriAttachment",
          "A",
          "Description",
          "Properties",
          "Property",
        ]
        : [
          "testsuites",
          "testsuite",
          "testcase",
          "failure",
          "error",
          "skipped",
          "properties",
          "property",
          "system-out",
          "system-err",
        ];
      if (!allowed.includes(local)) {
        throw new Error(`Unrecognized evidence element: ${local}`);
      }
      const attrs: Record<string, string> = Object.create(null);
      let remaining = token.slice(
        tag.length + 1,
        token.length - (self ? 2 : 1),
      );
      while (remaining.trim()) {
        const attr = /^\s+([A-Za-z_][\w:.-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/
          .exec(remaining);
        if (!attr || Object.hasOwn(attrs, attr[1])) {
          throw new Error("Malformed or repeated XML attribute");
        }
        attrs[attr[1]] = decode(attr[2] ?? attr[3]);
        remaining = remaining.slice(attr[0].length);
      }
      if (stack.length >= 60) throw new Error("XML too deeply nested");
      stack.push(tag);
      if (local === "testsuite") {
        suites.push(attrs.name ?? "");
        suiteCounts.push({ from: cases.length, declared: attrs });
      }
      if (local === "testcase") {
        if (
          root === "TestRun" || current || !suites.length || !attrs.name ||
          stack.at(-2)?.split(":").at(-1) !== "testsuite"
        ) throw new Error("Invalid JUnit testcase");
        const flag = attrs.status ?? attrs.result;
        if (
          flag &&
          ![
            "run",
            "passed",
            "success",
            "failed",
            "failure",
            "error",
            "skipped",
            "ignored",
            "notrun",
            "notexecuted",
            "disabled",
          ].includes(flag.toLowerCase())
        ) throw new Error("Unrecognized JUnit status");
        const outcome: Outcome = flag && /^(failed|failure)$/i.test(flag)
          ? "FAIL"
          : flag && /^error$/i.test(flag)
          ? "ERROR"
          : flag && /skipped|ignored|notrun|notexecuted|disabled/i.test(flag)
          ? "SKIP"
          : "PASS";
        current = {
          id: `${attrs.classname ?? suites.at(-1)}#${attrs.name}`,
          outcome,
          reason: "",
        };
      }
      if (["failure", "error", "skipped"].includes(local)) {
        if (!current || stack.at(-2)?.split(":").at(-1) !== "testcase") {
          throw new Error("Outcome outside testcase");
        }
        const outcome = local === "failure"
          ? "FAIL"
          : local === "error"
          ? "ERROR"
          : "SKIP";
        if (current.outcome === "PASS" || current.outcome === "SKIP") {
          current.outcome = outcome;
        }
        current.reason = attrs.message ?? "";
      }
      if (local === "UnitTestResult") {
        if (root !== "TestRun" || !attrs.testName) {
          throw new Error("Invalid TRX result");
        }
        const outcomes: Record<string, Outcome> = {
          Passed: "PASS",
          Failed: "FAIL",
          Error: "ERROR",
          Timeout: "ERROR",
          Aborted: "ERROR",
          NotExecuted: "SKIP",
          Inconclusive: "SKIP",
        };
        if (!Object.hasOwn(outcomes, attrs.outcome)) {
          throw new Error("Unrecognized TRX outcome");
        }
        append({
          id: attrs.testName.replace(/\.([^.()]+)(\(.*)?$/, "#$1$2"),
          outcome: outcomes[attrs.outcome],
          reason: "",
        });
      }
    }
    if (close || self) {
      if (stack.pop() !== tag) throw new Error("Mismatched XML closing tag");
      if (local === "testcase") {
        if (!current) throw new Error("Missing testcase");
        append(current);
        current = undefined;
      }
      if (local === "testsuite") {
        suites.pop();
        const suite = suiteCounts.pop()!;
        const measured = cases.slice(suite.from);
        const counts: Record<string, number> = {
          tests: measured.length,
          failures: measured.filter((t) => t.outcome === "FAIL").length,
          errors: measured.filter((t) => t.outcome === "ERROR").length,
          skipped: measured.filter((t) => t.outcome === "SKIP").length,
        };
        for (const [key, count] of Object.entries(counts)) {
          const declared = suite.declared[key];
          if (
            declared !== undefined &&
            (!/^\d{1,9}$/.test(declared) || Number(declared) !== count)
          ) {
            throw new Error(
              `JUnit ${key} count contradicts its per-test evidence`,
            );
          }
        }
      }
      if (!stack.length) closed = true;
    }
    pos += token.length;
  }
  if (stack.length || !closed) throw new Error("Unclosed XML document");
  return cases;
}
export function parseResultsJSON(value: unknown): TestCase[] {
  const o = object(value),
    entries = object(o.tests ?? o),
    cases: TestCase[] = [];
  for (const [id, value] of Object.entries(entries)) {
    if (!["PASS", "FAIL", "ERROR", "SKIP"].includes(String(value))) {
      throw new Error(
        "JSON evidence must contain per-test outcomes, not counts",
      );
    }
    cases.push({ id: text(id), outcome: value as Outcome, reason: "" });
  }
  if (cases.length > 100000) throw new Error("Too many JSON tests");
  return cases;
}
export function parseLog(raw: string): Counts {
  let passed = 0,
    failed = 0,
    skipped = 0,
    recognized = 0,
    ran: number | undefined;
  const add = (p: number, f: number, s: number): void => {
    if ([p, f, s].some((n) => !Number.isSafeInteger(n) || n < 0)) {
      throw new Error("Invalid runner summary");
    }
    passed += p;
    failed += f;
    skipped += s;
    recognized++;
  };
  for (const original of raw.split(/\r?\n/)) {
    const line = original.replace(
      /(\p{Cc})\[[0-9;]*m/gu,
      (sequence, control: string) =>
        control.charCodeAt(0) === 27 ? "" : sequence,
    );
    if (line.length > 2000) continue;
    let m: RegExpMatchArray | null;
    if ((m = line.match(/^Ran (\d+) tests? in [\d.]+s\s*$/))) {
      ran = Number(m[1]);
      continue;
    }
    if (ran !== undefined && line.trim()) {
      m = line.match(/^(OK|FAILED)(?: \(([^)]*)\))?\s*$/);
      if (m) {
        const counts = Object.fromEntries(
          [...m[2]?.matchAll(/(\w+)=(\d+)/g) ?? []].map(
            (x) => [x[1], Number(x[2])],
          ),
        );
        const f = (counts.failures ?? 0) + (counts.errors ?? 0),
          s = counts.skipped ?? 0;
        add(ran - f - s, f, s);
      }
      ran = undefined;
      if (m) continue;
    }
    if (
      (m = line.match(
        /^(?:\[\w+\]\s*)?Tests run: (\d+), Failures: (\d+), Errors: (\d+), Skipped: (\d+)\s*$/,
      ))
    ) {
      const [total, f, e, s] = m.slice(1).map(Number);
      add(total - f - e - s, f + e, s);
    } else if (
      (m = line.match(
        /^(\d+) tests? completed(?:, (\d+) failed)?(?:, (\d+) skipped)?\s*$/,
      ))
    ) {
      const total = Number(m[1]), f = Number(m[2] ?? 0), s = Number(m[3] ?? 0);
      add(total - f - s, f, s);
    } else if (
      (m = line.match(
        /^test result: (?:ok|FAILED)\. (\d+) passed; (\d+) failed; (\d+) ignored;/,
      ))
    ) add(Number(m[1]), Number(m[2]), Number(m[3]));
    else if ((m = line.match(/^\s*--- (PASS|FAIL|SKIP): \S/))) {
      add(
        m[1] === "PASS" ? 1 : 0,
        m[1] === "FAIL" ? 1 : 0,
        m[1] === "SKIP" ? 1 : 0,
      );
    } else if (line.startsWith("{")) {
      const item = object(JSON.parse(line));
      if (
        typeof item.Test === "string" &&
        ["pass", "fail", "skip"].includes(String(item.Action))
      ) {
        add(
          item.Action === "pass" ? 1 : 0,
          item.Action === "fail" ? 1 : 0,
          item.Action === "skip" ? 1 : 0,
        );
      }
    } else if (
      (m = line.match(
        /^(?:Passed|Failed)!\s+-\s+Failed:\s+(\d+),\s+Passed:\s+(\d+),\s+Skipped:\s+(\d+)/,
      ))
    ) add(Number(m[2]), Number(m[1]), Number(m[3]));
    else if (
      (m = line.match(/^\d+% tests passed, (\d+) tests? failed out of (\d+)/))
    ) add(Number(m[2]) - Number(m[1]), Number(m[1]), 0);
    else if ((m = line.match(/^OK \((\d+) tests?, \d+ assertions?\)/))) {
      add(Number(m[1]), 0, 0);
    } else if ((m = line.match(/^(Tests: \d+, Assertions: \d+.*?)\.?\s*$/))) {
      const c = Object.fromEntries(
        [...m[1].matchAll(/([A-Za-z]+):\s*(\d+)/g)].map(
          (x) => [x[1].toLowerCase(), Number(x[2])],
        ),
      );
      const f = (c.failures ?? 0) + (c.errors ?? 0),
        s = (c.skipped ?? 0) + (c.incomplete ?? 0);
      add(c.tests - f - s, f, s);
    } else if (
      (m = line.match(
        /^(?:=+ )?((?:\d+ [a-z]+(?:, )?)+) in [\d.]+s(?: \([\d:]+\))?(?: =+)?\s*$/,
      )) || (m = line.match(/^\s*Tests:\s+(.*\b\d+ total)\s*$/)) ||
      (m = line.match(/^\s*Tests\s{2,}(.*)\(\d+\)\s*$/))
    ) {
      const c = Object.fromEntries(
        [...m[1].matchAll(/(\d+)\s+([a-z]+)/g)].map(
          (x) => [x[2], Number(x[1])],
        ),
      );
      if (
        Object.keys(c).some((k) =>
          ![
            "passed",
            "failed",
            "skipped",
            "xpassed",
            "xfailed",
            "error",
            "errors",
            "total",
          ].includes(k)
        )
      ) throw new Error("Unknown summary outcome");
      add(
        (c.passed ?? 0) + (c.xpassed ?? 0) + (c.xfailed ?? 0),
        (c.failed ?? 0) + (c.error ?? 0) + (c.errors ?? 0),
        c.skipped ?? 0,
      );
    } else if (/^=+ no tests ran in [\d.]+s/.test(line)) add(0, 0, 0);
  }
  if (!recognized) {
    throw new Error(
      "No recognized runner summary; model-written counts are not evidence",
    );
  }
  return { passed, failed, skipped, executed: passed + failed };
}
export async function readEvidence(
  root: string,
  paths: unknown,
): Promise<Evidence> {
  const names = list(paths, 100).map((v) => text(v)),
    cases: TestCase[] = [],
    seen = new Set<string>(),
    ids = new Set<string>();
  const counts: Counts = { passed: 0, failed: 0, skipped: 0, executed: 0 };
  let oldest = Infinity, perTest = true, totalBytes = 0;
  for (const path of names) {
    if (seen.has(path)) throw new Error("Duplicate evidence file");
    seen.add(path);
    const file = await readWorkspaceFile(root, path),
      body = decodeUtf8(file.bytes).replace(/^\uFEFF/, "");
    totalBytes += file.bytes.length;
    if (totalBytes > 64 * 1024 * 1024) {
      throw new Error("Evidence exceeds aggregate 64 MiB");
    }
    oldest = Math.min(oldest, (await lstat(file.path)).mtimeMs);
    let parsed: TestCase[] | undefined;
    if (/\.(xml|trx)$/i.test(path)) parsed = parseXML(body);
    else if (/\.json$/i.test(path)) parsed = parseResultsJSON(JSON.parse(body));
    else if (/\.(log|txt|out)$/i.test(path)) perTest = false;
    else {throw new Error(
        "Evidence must be XML/TRX, per-test JSON, or runner log",
      );}
    const c = parsed ? tally(parsed) : parseLog(body);
    if (parsed) {
      for (const test of parsed) {
        if (ids.has(test.id)) {
          throw new Error(`Overlapping evidence test id: ${test.id}`);
        }
        ids.add(test.id);
        cases.push(test);
      }
    }
    for (const key of ["passed", "failed", "skipped", "executed"] as const) {
      counts[key] += c[key];
    }
  }
  return {
    cases,
    counts,
    oldest,
    sources: names,
    perTest: perTest && names.length > 0,
  };
}

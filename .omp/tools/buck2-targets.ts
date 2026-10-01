// SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

import { mkdtemp, open, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checked, lines, result, type Tool, type ToolAPI } from "../lib/tool.ts";

export interface TargetParams {
  pattern?: "current" | "trunk" | "full";
  from?: string;
  to?: string;
  scope?: string;
  build?: boolean;
  test?: boolean;
  preview?: number;
}

export async function createTargetsFile(): Promise<{ directory: string; path: string }> {
  const directory = await mkdtemp(join(tmpdir(), "omp-buck2-targets-"));
  const path = join(directory, "targets.txt");
  try {
    const file = await open(path, "wx", 0o600);
    await file.close();
    return { directory, path };
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}

export default function (pi: ToolAPI): Tool<TargetParams> {
  const t = pi.typebox.Type;
  return {
    name: "buck2_targets",
    label: "Buck2 Affected Targets",
    description: "Determine affected Buck2 targets between jj revisions, optionally build/test them. Retains a private nonempty target at-file for reuse and recovery; removes empty or incomplete selections.",
    approval: "exec",
    parameters: t.Object({
      pattern: t.Optional(t.Union([t.Literal("current"), t.Literal("trunk"), t.Literal("full")])),
      from: t.Optional(t.String({ minLength: 1 })),
      to: t.Optional(t.String({ minLength: 1 })),
      scope: t.Optional(t.String({ minLength: 1, description: "Target universe; defaults to depot//src/..." })),
      build: t.Optional(t.Boolean()),
      test: t.Optional(t.Boolean()),
      preview: t.Optional(t.Integer({ minimum: 0 })),
    }, { additionalProperties: false }),
    async execute(_id, params, onUpdate, _ctx, signal) {
      if ((params.from === undefined) !== (params.to === undefined)) {
        throw new Error("Supply both from and to revisions");
      }
      if (params.pattern !== undefined && params.from !== undefined) {
        throw new Error("Choose a pattern or explicit revisions, not both");
      }
      const patterns = { current: ["@-", "@"], trunk: ["trunk()", "@"], full: ["root()", "@"] } as const;
      const [from, to] = params.from !== undefined && params.to !== undefined
        ? [params.from, params.to]
        : patterns[params.pattern ?? "current"];
      const scope = params.scope ?? "depot//src/...";
      const preview = params.preview ?? 10;
      if (!Number.isSafeInteger(preview) || preview < 0) throw new Error("preview must be a nonnegative integer");
      signal?.throwIfAborted();
      const temporary = await createTargetsFile();
      let retained = false;
      let count = 0;
      try {
        onUpdate?.(result({ phase: "determine", from, to, scope }));
        await checked(pi, ["run", "root//buck/tools/tdutil:tdutil", "--", "--output", temporary.path,
          "--from", from, "--to", to, "--universe", scope], signal);
        const targets = lines(await readFile(temporary.path, "utf8"));
        count = targets.length;
        retained = count > 0;
        const actions: { action: string; output: string }[] = [];
        if (retained) {
          for (const action of ["build", "test"] as const) {
            if (!params[action]) continue;
            onUpdate?.(result({ phase: action, count, targetsFile: temporary.path }));
            actions.push({ action, output: await checked(pi, [action, `@${temporary.path}`], signal) });
          }
        }
        return result({ from, to, scope, count, preview: targets.slice(0, preview),
          targetsFile: retained ? temporary.path : null, retained, actions,
          ...(retained ? { cleanup: `Remove ${temporary.path} and its private parent directory when finished.` } : {}),
        });
      } catch (error) {
        if (retained) {
          throw new Error(`${error instanceof Error ? error.message : String(error)}\nAffected targets retained at ${temporary.path}; remove the file and its private parent directory when finished.`, { cause: error });
        }
        throw error;
      } finally {
        if (!retained) await rm(temporary.directory, { recursive: true, force: true });
      }
    },
  };
}

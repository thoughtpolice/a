// SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0
// Reimplemented portable Anthropic code-modernization workflows, ab024cdc (Apache-2.0).
import { join, resolve } from "node:path";
import { writeWorkspaceFile, workspacePath } from "../lib/files.ts";
import type { Tool, ToolAPI } from "../lib/tool.ts";
import { result } from "../lib/tool.ts";
import { json, object, selectedRoot, text } from "../skills/modernization/scripts/common.ts";
import { compare } from "../skills/modernization/scripts/compare.ts";
import { baselineDiff } from "../skills/modernization/scripts/baseline_diff.ts";
import { makeShards } from "../skills/modernization/scripts/make_shards.ts";
import { traceRules } from "../skills/modernization/scripts/trace_rules.ts";
import { upliftChecks } from "../skills/modernization/scripts/uplift_checks.ts";
import { proofPack, snapshot } from "../skills/modernization/scripts/proof_pack.ts";
import { renderRules } from "../skills/modernization/scripts/render_rules.ts";
import { buildReport } from "../skills/modernization/scripts/build_report.ts";
interface Parameters { sourceRoot: string; request: string; outputRoot: string; outputName: string; overwrite?: boolean }
export default function modernization(api: ToolAPI): Tool<Parameters>[] {
  const T = api.typebox.Type;
  const operations = ["compare", "baseline", "shards", "trace", "uplift", "proof", "snapshot", "report", "render_rules"] as const;
  const descriptions: Record<typeof operations[number], string> = {
    compare: "Compare bounded output bytes with reasoned masks/tolerances and anti-tautology self-checks",
    baseline: "Compare measured old/new test evidence; refuse missing or unrecognized evidence",
    shards: "Produce deterministic bounded source shards from tree or topology",
    trace: "Trace rule ids to code, named tests, and passing executed per-test evidence",
    uplift: "Compare kept test files and identify unnamed silent version-delta sites",
    proof: "Recompute modernization proof from current measured evidence; never consume claimed pass counts",
    snapshot: "Capture read-only source SHA-256 inventory before modernization",
    report: "Render offline safe HTML/Markdown with recomputed current proof and topology",
    render_rules: "Render safe rule cards and data-object catalog without inventing verification or approval",
  };
  return operations.map<Tool<Parameters>>(operation => ({
    name: `modernization_${operation}`, label: `Modernization ${operation}`, description: `${descriptions[operation]}. Reads a JSON request under explicit sourceRoot; writes private artifacts under workspace outputRoot. No execution/build proxy. Read skill://modernization/references/contracts.md for schemas.`,
    approval: "write" as const,
    parameters: T.Object({ sourceRoot: T.String({ description: "Explicit selected artifact/source directory, relative to workspace or absolute" }), request: T.String({ description: "JSON request path relative to sourceRoot" }), outputRoot: T.String({ description: "Output directory inside current workspace" }), outputName: T.String({ pattern: "^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$" }), overwrite: T.Optional(T.Boolean({ default: false })) }),
    async execute(_id, params, _onUpdate, _ctx, signal) {
      signal?.throwIfAborted();
      const root = await selectedRoot(resolve(api.cwd, text(params.sourceRoot))), request = await json(root, text(params.request));
      const name = text(params.outputName, 80); if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/.test(name)) throw new Error("Unsafe artifact name");
      await workspacePath(api.cwd, text(params.outputRoot));
      const output: { suffix: string; body: string }[] = []; let details: unknown;
      if (operation === "compare") details = await compare(root, request);
      else if (operation === "baseline") details = await baselineDiff(root, request);
      else if (operation === "shards") details = await makeShards(root, request);
      else if (operation === "trace") details = await traceRules(root, request);
      else if (operation === "uplift") details = await upliftChecks(root, request);
      else if (operation === "proof") details = await proofPack(root, request);
      else if (operation === "snapshot") details = await snapshot(resolve(root, text(object(request).sourceRoot)));
      else if (operation === "render_rules") {
        const rendered = renderRules(request); details = { count: rendered.count };
        output.push({ suffix: "-rules.md", body: rendered.rules }, { suffix: "-data-objects.md", body: rendered.dataObjects });
      } else {
        const report = await buildReport(root, request); details = { verdict: report.verdict, next: report.next, warnings: report.warnings, facts: report.facts };
        output.push({ suffix: ".html", body: report.html }, { suffix: ".md", body: report.markdown });
      }
      if (!output.length) output.push({ suffix: ".json", body: JSON.stringify(details, null, 2) + "\n" });
      const paths: string[] = [];
      for (const artifact of output) { signal?.throwIfAborted(); paths.push(await writeWorkspaceFile(api.cwd, join(params.outputRoot, name + artifact.suffix), artifact.body, params.overwrite ?? false)); }
      return result({ paths, evidence: details });
    },
  }));
}

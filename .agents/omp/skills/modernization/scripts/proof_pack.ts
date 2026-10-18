// SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0
// Modified adaptation of Anthropic proof_pack.py, Apache-2.0, ab024cdc.
import { lstat } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { readWorkspaceFile, workspacePath } from "../../../lib/files.ts";
import {
  content,
  fileSet,
  isTooling,
  json,
  kind,
  list,
  object,
  selectedRoot,
  sha,
  text,
  walk,
} from "./common.ts";
import { compare } from "./compare.ts";
import { baselineDiff } from "./baseline_diff.ts";
import type { BaselineComparison } from "./baseline_diff.ts";
import { readEvidence } from "./evidence.ts";
import { traceRules } from "./trace_rules.ts";
import { upliftChecks } from "./uplift_checks.ts";
export interface Check {
  id: string;
  state: "pass" | "gap" | "fail" | "na";
  detail: string;
}
export async function snapshot(sourceRoot: string) {
  const root = await selectedRoot(sourceRoot),
    files = await fileSet(root, false);
  if (!Object.keys(files).length) {
    throw new Error("Cannot snapshot empty source");
  }
  return {
    version: 1,
    files,
    method: "SHA-256 of every regular file; source is never executed",
  };
}
export async function proofPack(root: string, value: unknown) {
  const spec = object(value),
    code = text(spec.code),
    track = text(spec.track, 30);
  if (!["rewrite", "uplift", "rearchitecture"].includes(track)) {
    throw new Error("Unknown modernization track");
  }
  const checks: Check[] = [],
    evidence: Record<string, unknown> = {},
    problems: string[] = [];
  const add = (id: string, state: Check["state"], detail: string): void => {
    checks.push({ id, state, detail });
  };
  const clean = await readEvidence(root, spec.results ?? []);
  evidence.tests = clean;
  const codeRoot = await workspacePath(root, code),
    prefix = relative(root, codeRoot);
  const files = (await walk(codeRoot)).map((p) => join(prefix, p)).filter((p) =>
    !/\.(md|txt|rst|adoc)$/i.test(p)
  );
  if (!files.length) throw new Error("No candidate code files found");
  if (files.every((f) => kind(f) !== "main" || isTooling(f))) {
    throw new Error(
      "Candidate contains test tooling only, not an implemented module",
    );
  }
  let newestCode = 0;
  for (const file of files) {
    newestCode = Math.max(
      newestCode,
      (await lstat(await workspacePath(root, file))).mtimeMs,
    );
  }
  if (!clean.sources.length) {
    add("tests", "gap", "No measured test evidence supplied");
  } else if (!clean.counts.executed) add("tests", "fail", "No test executed");
  else if (clean.counts.failed && track !== "uplift") {
    add("tests", "fail", "Measured test failures");
  } else if (clean.oldest < newestCode) {
    add(
      "tests",
      "gap",
      "Results predate candidate code; run the current Buck2 target again",
    );
  } else if (
    clean.counts.skipped &&
    (!clean.perTest ||
      clean.cases.some((t) => t.outcome === "SKIP" && !t.reason.trim()))
  ) add("tests", "gap", "Skipped tests lack individual reasons");
  else add("tests", "pass", `${clean.counts.executed} measured tests executed`);
  if (track === "uplift") {
    add("rules", "na", "Uplift retains code; measured baseline applies");
  } else if (spec.rules === undefined) {
    add("rules", "gap", "No rule catalog supplied");
  } else {
    const trace = await traceRules(root, {
      rules: text(spec.rules),
      modules: [{
        name: code,
        path: code,
        results: spec.results ?? [],
        notes: spec.notes,
      }],
    });
    evidence.rules = trace;
    add(
      "rules",
      trace.ok ? "pass" : "gap",
      trace.ok
        ? "P0 rules have executed passing evidence"
        : `Unexecuted P0 rules: ${trace.gaps.join(", ") || "empty catalog"}`,
    );
  }
  const development = spec.development === undefined
    ? undefined
    : await compare(root, await json(root, text(spec.development)));
  if (development) evidence.development = development;
  let baseline: BaselineComparison | undefined;
  if (track === "uplift" && spec.baseline !== undefined) {
    baseline = await baselineDiff(root, {
      ...object(spec.baseline),
      fresh: spec.results ?? [],
    });
    evidence.baseline = baseline;
  }
  if (development && !development.ok || baseline?.fail) {
    add("same", "fail", "Current comparison or measured baseline fails");
  } else if (development && development.oldest < newestCode) {
    add("same", "gap", "Development outputs predate current candidate code");
  } else if (track === "uplift" && baseline) {
    add(
      "same",
      baseline.ok ? "pass" : "gap",
      baseline.ok
        ? "Measured baseline has no regression or missing evidence"
        : "Baseline has gaps",
    );
  } else {add(
      "same",
      development?.ok ? "pass" : "gap",
      development?.ok
        ? "Current development outputs compare equal"
        : "No current development comparison",
    );}
  if (spec.fresh === undefined) {
    add(
      "fresh",
      "gap",
      "No fresh paired-output and input evidence supplied; target-only cannot be PROVEN",
    );
  } else {
    const fresh = await compare(root, await json(root, text(spec.fresh)));
    evidence.fresh = fresh;
    const previousInputs = new Set(
        development?.cases.map((c) => c.inputHash).filter(Boolean),
      ),
      previousOutputs = new Set(
        development?.cases.map((c) => c.legacyHash).filter(Boolean),
      );
    const distinct = new Set(
      fresh.cases.filter((c) =>
        c.inputHash && !c.empty && !previousInputs.has(c.inputHash) &&
        !previousOutputs.has(c.legacyHash)
      ).map((c) => c.inputHash),
    );
    evidence.freshInputsCounted = distinct.size;
    add(
      "fresh",
      !fresh.ok
        ? "fail"
        : !development || distinct.size < 10 || fresh.oldest < newestCode
        ? "gap"
        : "pass",
      `${distinct.size} distinct fresh file inputs, excluding reused development inputs/outputs; minimum 10; outputs/inputs must postdate candidate code`,
    );
  }
  const canaries = list(spec.canaries ?? [], 20),
    cleanBad = new Set(
      clean.cases.filter((t) => t.outcome === "FAIL" || t.outcome === "ERROR")
        .map((t) => t.id),
    );
  let canaryState: Check["state"] = "gap";
  const canaryEvidence: unknown[] = [];
  for (const value of canaries) {
    const c = object(value),
      patchPath = text(c.patch),
      patch = await content(root, patchPath),
      lines = patch.split("\n");
    const removed = lines.filter((l) =>
        l.startsWith("-") && !l.startsWith("---")
      ),
      added = lines.filter((l) => l.startsWith("+") && !l.startsWith("+++"));
    const target = lines.find((l) => l.startsWith("+++ "))?.slice(4).replace(
      /^b\//,
      "",
    );
    if (
      removed.length !== 1 || added.length !== 1 ||
      removed[0].slice(1) === added[0].slice(1) || !lines.some((l) =>
        /^@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@/.test(l)
      ) || !target || !files.includes(target)
    ) {
      throw new Error(
        "Canary evidence must be a one-line changed candidate-code patch",
      );
    }
    const restored = (await content(root, target)).split(/\r?\n/);
    if (
      !restored.includes(removed[0].slice(1)) ||
      restored.includes(added[0].slice(1))
    ) throw new Error("Candidate does not show the canary line restored");
    const run = await readEvidence(root, c.results),
      patchTime =
        (await lstat((await readWorkspaceFile(root, patchPath)).path)).mtimeMs;
    const more = run.perTest
      ? run.cases.filter((t) =>
        (t.outcome === "FAIL" || t.outcome === "ERROR") && !cleanBad.has(t.id)
      ).length
      : Math.max(0, run.counts.failed - clean.counts.failed);
    const state: Check["state"] = !run.sources.length || run.oldest < patchTime
      ? "gap"
      : !more
      ? "fail"
      : "pass";
    if (state === "fail" || canaryState !== "fail" && state === "pass") {
      canaryState = state;
    }
    canaryEvidence.push({
      patchHash: sha(patch),
      target,
      newFailures: more,
      state,
      run,
    });
  }
  evidence.canaries = canaryEvidence;
  add(
    "canary",
    canaryState,
    "One-line break must produce measured new failures after patch evidence was recorded; restore and re-run clean code",
  );
  if (spec.sourceSnapshot === undefined || spec.sourceRoot === undefined) {
    add("source", "gap", "No pre-edit source hash snapshot supplied");
  } else {
    const original = object(await json(root, text(spec.sourceSnapshot))),
      expected = object(original.files),
      current = await snapshot(resolve(root, text(spec.sourceRoot)));
    if (
      original.version !== 1 ||
      Object.values(expected).some((hash) =>
        typeof hash !== "string" || !/^[0-9a-f]{64}$/.test(hash)
      )
    ) throw new Error("Unrecognized source snapshot");
    const changed = [
      ...new Set([...Object.keys(expected), ...Object.keys(current.files)]),
    ].filter((p) => expected[p] !== current.files[p]);
    evidence.source = {
      method: current.method,
      changed,
      files: Object.keys(current.files).length,
    };
    add(
      "source",
      Object.keys(expected).length && !changed.length ? "pass" : "gap",
      changed.length
        ? "Source bytes or paths changed since snapshot"
        : "Current source matches pre-edit SHA-256 snapshot",
    );
  }
  if (track === "uplift") {
    add(
      "baseline",
      baseline?.measured && !baseline.conflicts.length ? "pass" : "gap",
      "Old-version baseline must be parsed from measured evidence and agree with any declared table",
    );
    if (spec.uplift === undefined) {
      add("kept", "gap", "No legacy/candidate test file comparison");
      add("deltas", "gap", "No version delta catalog");
    } else {
      const up = await upliftChecks(root, spec.uplift);
      evidence.uplift = up;
      add(
        "kept",
        up.testsKept.ok ? "pass" : "gap",
        "No legacy test removed; at most 25% changed; nonempty legacy test set",
      );
      add(
        "deltas",
        up.deltas.ok ? "pass" : "gap",
        "Silent delta sites named by tests; configuration-only sites require separate proof",
      );
    }
  }
  if (spec.brief !== undefined) {
    problems.push(
      ...(await content(root, text(spec.brief))).split("\n").filter((l) =>
        /^\s*[-*]\s+\[ \]/.test(l)
      ),
    );
  }
  const verdict = checks.some((c) => c.state === "fail")
    ? "NOT PROVEN"
    : checks.some((c) => c.state === "gap")
    ? "PARTLY PROVEN"
    : "PROVEN";
  return {
    version: 1,
    track,
    code,
    verdict,
    checks,
    evidence,
    needsPerson: problems,
    limits: [
      "Sampled behavior only: no proof of all inputs, security, throughput, capacity or concurrency",
      "A named rule or delta site is not proof of test quality",
      "Canary shows only the recorded break was detectable",
      "Filesystem evidence is not authenticated; capture it from real runs, never type outcomes or fabricate approvals",
    ],
    signoff: null,
  };
}

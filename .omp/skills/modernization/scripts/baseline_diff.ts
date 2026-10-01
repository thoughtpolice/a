// SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0
// Modified adaptation of Anthropic baseline_diff.py, Apache-2.0, ab024cdc.
import { list, object, strings, text } from "./common.ts";
import { parseResultsJSON, readEvidence, tally } from "./evidence.ts";
import type { Counts } from "./evidence.ts";
export interface BaselineComparison {
  ok: boolean;
  fail: boolean;
  gap: boolean;
  before: Counts;
  now: Counts;
  measured: boolean;
  perTest: boolean;
  conflicts: string[];
  regressions: string[];
  newFailures: string[];
  stillFailing: string[];
  fixed: string[];
  newlySkipped: string[];
  newlyRun: string[];
  missing: string[];
  missingModules: string[];
  moduleDiffs: { module: string; before: Counts; now: Counts }[];
  renamed: string[];
  flaky: string[];
  approved: { id: string; reason: string }[];
  executedDrop: boolean;
  skippedGrowth: boolean;
}
export async function baselineDiff(
  root: string,
  value: unknown,
): Promise<BaselineComparison> {
  const spec = object(value),
    before = await readEvidence(root, spec.baseline),
    now = await readEvidence(root, spec.fresh);
  const conflicts: string[] = [],
    regressions: string[] = [],
    newFailures: string[] = [],
    stillFailing: string[] = [],
    fixed: string[] = [],
    newlySkipped: string[] = [],
    newlyRun: string[] = [],
    missing: string[] = [],
    renamed: string[] = [],
    flaky: string[] = [];
  if (spec.declared !== undefined) {
    const declared = parseResultsJSON(spec.declared),
      measured = new Map(before.cases.map((t) => [t.id, t.outcome]));
    for (const t of declared) {
      if (measured.get(t.id) !== t.outcome) {
        conflicts.push(`Declared baseline disagrees: ${t.id}`);
      }
    }
    if (declared.length !== before.cases.length) {
      conflicts.push("Declared baseline omits measured tests");
    }
  }
  for (const alternate of list(spec.crossChecks ?? [], 20)) {
    const other = await readEvidence(root, alternate);
    if (JSON.stringify(other.counts) !== JSON.stringify(before.counts)) {
      conflicts.push("Baseline evidence sources disagree on counts");
    }
    if (other.perTest && before.perTest) {
      const tests = new Map(before.cases.map((t) => [t.id, t.outcome]));
      if (
        other.cases.length !== before.cases.length ||
        other.cases.some((t) => tests.get(t.id) !== t.outcome)
      ) conflicts.push("Baseline per-test evidence sources disagree");
    }
  }
  const flakyIds = new Set(strings(spec.flaky ?? [])),
    old = new Map(before.cases.map((t) => [t.id, t])),
    fresh = new Map(now.cases.map((t) => [t.id, t]));
  const bad = (outcome: string): boolean =>
    outcome === "FAIL" || outcome === "ERROR";
  for (const t of before.cases) {
    const n = fresh.get(t.id);
    if (!n) {
      missing.push(t.id);
      continue;
    }
    if (t.outcome === "PASS" && bad(n.outcome)) {
      (flakyIds.has(t.id) ? flaky : regressions).push(t.id);
    }
    if (bad(t.outcome) && bad(n.outcome)) stillFailing.push(t.id);
    if (bad(t.outcome) && n.outcome === "PASS") fixed.push(t.id);
    if (t.outcome === "PASS" && n.outcome === "SKIP") newlySkipped.push(t.id);
    if (t.outcome === "SKIP" && n.outcome !== "SKIP") {
      newlyRun.push(t.id);
      if (bad(n.outcome)) newFailures.push(t.id);
    }
  }
  for (const t of now.cases) {
    if (!old.has(t.id) && bad(t.outcome)) newFailures.push(t.id);
  }
  const classes = new Set(missing.map((id) => id.split("#")[0]));
  for (const klass of classes) {
    const gone = missing.filter((id) => id.split("#")[0] === klass),
      added = now.cases.filter((t) =>
        !old.has(t.id) && t.id.split("#")[0] === klass
      );
    const b = tally(before.cases.filter((t) => t.id.split("#")[0] === klass)),
      n = tally(now.cases.filter((t) => t.id.split("#")[0] === klass));
    if (
      added.length && n.executed >= b.executed && n.failed <= b.failed &&
      n.skipped <= b.skipped
    ) {
      renamed.push(...gone);
      for (const id of gone) missing.splice(missing.indexOf(id), 1);
    }
  }
  const approvals = object(spec.approved ?? {}),
    approved: { id: string; reason: string }[] = [];
  for (const group of [regressions, newFailures]) {
    for (let i = group.length - 1; i >= 0; i--) {
      const reason = approvals[group[i]];
      if (reason !== undefined) {
        approved.push({ id: group[i], reason: text(reason, 300) });
        group.splice(i, 1);
      }
    }
  }
  const executedDrop = now.counts.executed < before.counts.executed,
    skippedGrowth = now.counts.skipped > before.counts.skipped;
  const missingModules = [
    ...new Set(before.cases.map((t) => t.id.split("#")[0])),
  ].filter((k) => !now.cases.some((t) => t.id.split("#")[0] === k));
  const moduleDiffs = [...new Set(before.cases.map((t) => t.id.split("#")[0]))]
    .flatMap((k) => {
      const b = tally(before.cases.filter((t) => t.id.split("#")[0] === k)),
        n = tally(now.cases.filter((t) => t.id.split("#")[0] === k));
      return n.executed < b.executed || n.skipped > b.skipped
        ? [{ module: k, before: b, now: n }]
        : [];
    });
  const fail = !before.counts.executed || !now.counts.executed ||
    regressions.length > 0 || newFailures.length > 0 ||
    (!before.perTest && now.counts.failed > before.counts.failed);
  const gap = !before.sources.length || !now.sources.length ||
    conflicts.length > 0 || missing.length > 0 || newlySkipped.length > 0 ||
    missingModules.length > 0 || moduleDiffs.length > 0 || executedDrop ||
    skippedGrowth || flaky.length > 0;
  return {
    ok: !fail && !gap,
    fail,
    gap,
    before: before.counts,
    now: now.counts,
    measured: before.sources.length > 0,
    perTest: before.perTest && now.perTest,
    conflicts,
    regressions,
    newFailures,
    stillFailing,
    fixed,
    newlySkipped,
    newlyRun,
    missing,
    missingModules,
    moduleDiffs,
    renamed,
    flaky,
    approved,
    executedDrop,
    skippedGrowth,
  };
}

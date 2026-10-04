// SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

import {
  aggregateBenchmark,
  type ArtifactRun,
  statistics,
} from "../tools/skill-benchmark.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
function rejects(action: () => unknown) {
  let failed = false;
  try {
    action();
  } catch {
    failed = true;
  }
  assert(failed, "Expected malformed evidence to fail");
}
function measured(
  variant: string,
  run: number,
  passed: boolean,
  seconds: number,
  tokens: number,
): ArtifactRun {
  return {
    case: "duplicate-records",
    variant,
    run,
    grading: {
      expectations: [{
        text: "Preserve duplicate records",
        passed,
        evidence: passed
          ? "Observed both repeated records"
          : "Observed only one record",
      }],
    },
    timing: { total_duration_seconds: seconds, total_tokens: tokens },
  };
}

Deno.test("benchmark computes sample statistics and primary-minus-baseline paired deltas", () => {
  const output = aggregateBenchmark(["new", "old"], [
    measured("new", 1, true, 3, 10),
    measured("old", 1, false, 5, 20),
    measured("new", 2, true, 7, 30),
    measured("old", 2, true, 6, 25),
  ]);
  assert(
    output.summary.new.time_seconds.mean === 5 &&
      Math.abs((output.summary.new.time_seconds.stddev ?? 0) - Math.sqrt(8)) <
        1e-12,
    "Sample standard deviation uses n-1",
  );
  assert(
    output.pairedDelta.pass_rate.mean === 0.5 &&
      output.pairedDelta.pass_rate.n === 2,
    "Both matched pass-rate observations contribute",
  );
  assert(
    output.pairedDelta.time_seconds.mean === -0.5 &&
      output.pairedDelta.tokens.mean === -2.5,
    "Deltas use caller-selected variant order, not lexical order",
  );
  assert(
    output.pairs[0].deltas.time_seconds === -2 &&
      output.pairs[1].deltas.time_seconds === 1,
    "Individual pairs remain visible",
  );
});

Deno.test("measured zero differs from absent metrics and output characters are not tokens", () => {
  const output = aggregateBenchmark(["a", "b"], [{
    case: "one",
    run: 1,
    variant: "a",
    grading: { expectations: [], execution_metrics: { output_chars: 5000 } },
    timing: { total_duration_seconds: 0, total_tokens: 0 },
  }, { case: "one", run: 1, variant: "b", grading: { expectations: [] } }]);
  assert(
    output.runs[0].values.time_seconds === 0 &&
      output.runs[0].values.tokens === 0,
    "True zero measurements preserved",
  );
  assert(
    output.runs[1].values.tokens === null && output.summary.b.tokens.n === 0 &&
      output.summary.b.tokens.mean === null,
    "Absent evidence remains null",
  );
  assert(
    output.pairedDelta.tokens.mean === null &&
      output.runs[0].values.pass_rate === null,
    "Missing metric and empty assertions cannot manufacture comparison scores",
  );
  const chars = aggregateBenchmark(["a", "b"], [{
    case: "one",
    run: 1,
    variant: "a",
    grading: { execution_metrics: { output_chars: 9000 } },
  }]);
  assert(
    chars.runs[0].values.tokens === null,
    "Characters never count as token measurements",
  );
});

Deno.test("missing grading evidence and mismatched assertions exclude pass-rate deltas", () => {
  const incomplete = measured("a", 1, true, 1, 1);
  incomplete.grading = {
    expectations: [{ text: "Preserve duplicate records", passed: true }],
  };
  const output = aggregateBenchmark(["a", "b"], [
    incomplete,
    measured("b", 1, false, 2, 2),
  ]);
  assert(
    output.runs[0].values.pass_rate === null &&
      output.runs[0].missing.some((s) => s.includes("evidence")),
    "Bare grader assertion cannot pass",
  );
  const unlike = measured("a", 1, true, 1, 1);
  unlike.grading = {
    expectations: [{
      text: "Different rubric",
      passed: true,
      evidence: "Observed it",
    }],
  };
  const mismatched = aggregateBenchmark(["a", "b"], [
    unlike,
    measured("b", 1, false, 2, 2),
  ]);
  assert(
    mismatched.pairedDelta.pass_rate.n === 0 &&
      mismatched.pairs[0].missing.includes(
        "pass_rate: unlike expectation sets",
      ),
    "Unlike rubrics are not paired pass rates",
  );
  assert(
    mismatched.pairedDelta.time_seconds.mean === -1,
    "Independent measured metrics may still compare",
  );
});

Deno.test("unpaired cases contribute only to their own summaries", () => {
  const output = aggregateBenchmark(["new", "old"], [
    measured("new", 1, true, 3, 10),
    measured("old", 2, false, 9, 20),
  ]);
  assert(
    output.summary.new.time_seconds.mean === 3 &&
      output.summary.old.time_seconds.mean === 9,
    "Variant measurements retained",
  );
  assert(
    output.pairedDelta.time_seconds.n === 0 &&
      output.pairs.every((p) =>
        p.missing.some((s) => s.startsWith("Unpaired"))
      ),
    "Unmatched run IDs do not form a manufactured pair",
  );
});

Deno.test("invalid measurements, duplicate identities and contradicting grades fail", () => {
  const run = measured("new", 1, true, 3, 10);
  rejects(() => aggregateBenchmark(["new", "old"], [run, run]));
  rejects(() => aggregateBenchmark(["new", "new"], [run]));
  for (const value of [-1, Infinity, NaN, "3"]) {
    rejects(() =>
      aggregateBenchmark(["new", "old"], [{
        ...run,
        timing: { total_duration_seconds: value },
      }])
    );
  }
  rejects(() =>
    aggregateBenchmark(["new", "old"], [{
      ...run,
      timing: { total_tokens: 1.5 },
    }])
  );
  rejects(() =>
    aggregateBenchmark(["new", "old"], [{
      ...run,
      grading: {
        expectations: [{
          text: "Preserve duplicate records",
          passed: true,
          evidence: "Observed both",
        }],
        summary: { passed: 0 },
      },
    }])
  );
  const empty = statistics([]);
  assert(
    empty.n === 0 && empty.stddev === null && empty.min === null,
    "No samples do not yield misleading statistics",
  );
  const singleton = statistics([4]);
  assert(
    singleton.mean === 4 && singleton.stddev === 0 && singleton.min === 4 &&
      singleton.max === 4,
    "Singleton measurement has defined statistics",
  );
});

Deno.test("finite large measurements do not overflow intermediate statistics", () => {
  const equal = statistics([1e308, 1e308]);
  assert(
    equal.mean === 1e308 && equal.stddev === 0,
    "Large identical measurements retain a finite mean and zero spread",
  );
  const opposite = statistics([-1e308, 1e308]);
  assert(
    opposite.mean === 0 &&
      Math.abs((opposite.stddev ?? 0) / 1e308 - Math.sqrt(2)) < 1e-12,
    "Representable spread survives an unrepresentable intermediate variance",
  );
  rejects(() => statistics([-Number.MAX_VALUE, Number.MAX_VALUE]));
});

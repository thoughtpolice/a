// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * Pure regression tests for TAP coverage and deflaking policy.
 *
 * These exercise budget carry-over, test-lineage invalidation, honest inherited
 * coverage, infrastructure failures, and noise estimation without celld fakes.
 * They intentionally distinguish a previous passing baseline from a currently
 * passing test, since conflating those would incorrectly green deferred epochs.
 *
 * @module
 */

import {
  classifyObservations,
  type CoverageEntry,
  flakeRate,
  type ObservationOutcome,
  selectCoverage,
  type TestIdentity,
  updateCoverage,
} from "./policy.ts";

/** Small dependency-free assertion for this isolated policy test module. */
function assert(
  condition: unknown,
  message = "assertion failed",
): asserts condition {
  if (!condition) throw new Error(message);
}

/** Compares JSON-safe records and arrays deterministically. */
function equal(actual: unknown, expected: unknown): void {
  assert(
    JSON.stringify(actual) === JSON.stringify(expected),
    `${JSON.stringify(actual)} != ${JSON.stringify(expected)}`,
  );
}

/** Creates a test identity without introducing repository-specific model types. */
function testIdentity(key: string, changed = false): TestIdentity {
  return {
    test_key: key,
    label: `root//tests:${key}`,
    platform: "linux-x86_64",
    changed,
  };
}

/** Creates a previously green coverage record with optional policy edge cases. */
function coverage(
  key: string,
  overrides: Partial<CoverageEntry> = {},
): CoverageEntry {
  return {
    test_key: key,
    label: `root//tests:${key}`,
    platform: "linux-x86_64",
    last_pass: "rev-before",
    last_revision: "rev-before",
    pending: false,
    flake_passes: 12,
    flake_failures: 1,
    ...overrides,
  };
}

Deno.test("coverage selects a sorted bounded union of affected and previously pending tests", () => {
  const known = {
    z: coverage("z", { pending: true }),
    a: coverage("a"),
    b: coverage("b", { pending: true }),
    untouched: coverage("untouched"),
  };
  const selection = selectCoverage(
    known,
    [testIdentity("c"), testIdentity("a", true)],
    "rev-next",
    2,
  );
  equal(selection.selected, [testIdentity("a", true), testIdentity("b")]);
  equal(selection.deferred, [testIdentity("c"), testIdentity("z")]);
  equal(selection.inherited, [coverage("untouched")]);
});

Deno.test("coverage current affected metadata overrides pending metadata and preserves changed", () => {
  const current = {
    ...testIdentity("test", true),
    label: "root//renamed:test",
    platform: "darwin-arm64",
  };
  const selection = selectCoverage(
    { test: coverage("test", { pending: true }) },
    [current],
    "next",
    1,
  );
  equal(selection.selected, [current]);
  equal(selection.deferred, []);
  equal(selection.inherited, []);
});

Deno.test("coverage excludes changed or affected old green baselines even with zero budget", () => {
  const selection = selectCoverage(
    { a: coverage("a"), b: coverage("b") },
    [testIdentity("a", true), testIdentity("b")],
    "next",
    0,
  );
  equal(selection.selected, []);
  equal(selection.deferred, [testIdentity("a", true), testIdentity("b")]);
  equal(selection.inherited, []);
});

Deno.test("coverage inherits only untouched non-pending currently passing tests", () => {
  const known = {
    green: coverage("green"),
    failed: coverage("failed", { last_revision: "failed-revision" }),
    pending: coverage("pending", { pending: true }),
    untested: coverage("untested", { last_pass: null, last_revision: null }),
    unknown: coverage("unknown", { last_revision: null }),
  };
  const selection = selectCoverage(known, [], "next", 3);
  equal(selection.inherited, [coverage("green")]);
  equal(selection.selected, [testIdentity("pending")]);
});

Deno.test("coverage new and deferred tests are never inferred as passing", () => {
  const selection = selectCoverage(
    {},
    [testIdentity("new-a"), testIdentity("new-b")],
    "next",
    1,
  );
  equal(selection.selected, [testIdentity("new-a")]);
  equal(selection.deferred, [testIdentity("new-b")]);
  equal(selection.inherited, []);
});

Deno.test("coverage selection is non-mutating and its snapshots are independent", () => {
  const known = {
    pending: coverage("pending", { pending: true }),
    green: coverage("green"),
  };
  const affected = [testIdentity("affected", true)];
  const before = JSON.stringify({ known, affected });
  const selection = selectCoverage(known, affected, "next", 1);
  selection.selected[0].label = "mutated";
  selection.deferred[0].changed = true;
  selection.inherited[0].last_pass = "mutated";
  equal(JSON.stringify({ known, affected }), before);
});

Deno.test("coverage duplicate current identities cannot hide a changed test", () => {
  const selection = selectCoverage(
    {},
    [testIdentity("a", true), testIdentity("a", false)],
    "next",
    10,
  );
  equal(selection.selected, [testIdentity("a", true)]);
});

Deno.test("coverage rejects invalid budgets, revisions, and conflicting identities", () => {
  const calls = [
    () => selectCoverage({}, [], "next", -1),
    () => selectCoverage({}, [], "next", 0.5),
    () => selectCoverage({}, [], "next", NaN),
    () => selectCoverage({}, [], "", 1),
    () =>
      selectCoverage(
        {},
        [testIdentity("a"), { ...testIdentity("a"), platform: "other" }],
        "next",
        1,
      ),
  ];
  for (const call of calls) {
    let threw = false;
    try {
      call();
    } catch {
      threw = true;
    }
    assert(threw);
  }
});

Deno.test("deflaking classification ignores infra errors and distinguishes actual observations", () => {
  const cases: [ObservationOutcome[], string][] = [
    [[], "infra_failure"],
    [["infra_failure", "infra_failure"], "infra_failure"],
    [["pass"], "pass"],
    [["pass", "pass", "infra_failure"], "pass"],
    [["fail"], "fail"],
    [["fail", "infra_failure", "fail"], "fail"],
    [["pass", "fail"], "flaky"],
    [["fail", "infra_failure", "pass"], "flaky"],
  ];
  for (const [observations, expected] of cases) {
    equal(classifyObservations(observations), expected);
  }
});

Deno.test("coverage a new all-failing test has no fabricated passing baseline", () => {
  equal(
    updateCoverage(undefined, testIdentity("new"), "next", ["fail", "fail"]),
    {
      test_key: "new",
      label: "root//tests:new",
      platform: "linux-x86_64",
      last_pass: null,
      last_revision: "next",
      pending: false,
      flake_passes: 0,
      flake_failures: 2,
    },
  );
});

Deno.test("coverage all-failing unchanged tests retain a baseline but cannot inherit green", () => {
  const updated = updateCoverage(
    coverage("test"),
    testIdentity("test"),
    "failed",
    [
      "fail",
      "infra_failure",
    ],
  );
  equal(updated.last_pass, "rev-before");
  equal(updated.last_revision, "failed");
  equal(updated.pending, false);
  equal(updated.flake_passes, 12);
  equal(updated.flake_failures, 2);
  equal(selectCoverage({ test: updated }, [], "next", 10).inherited, []);
});

Deno.test("coverage changed tests discard prior passing baselines and observation counters", () => {
  const updated = updateCoverage(
    coverage("test"),
    testIdentity("test", true),
    "changed",
    ["fail"],
  );
  equal(updated.last_pass, null);
  equal(updated.last_revision, "changed");
  equal(updated.flake_passes, 0);
  equal(updated.flake_failures, 1);
  equal(updated.pending, false);
});

Deno.test("coverage changed passing tests establish only a fresh baseline", () => {
  const updated = updateCoverage(
    coverage("test"),
    testIdentity("test", true),
    "changed",
    [
      "fail",
      "pass",
    ],
  );
  equal(updated.last_pass, "changed");
  equal(updated.last_revision, "changed");
  equal(updated.flake_passes, 1);
  equal(updated.flake_failures, 1);
  equal(updated.pending, false);
});

Deno.test("coverage mixed pass fail cohorts advance baseline using genuine observations only", () => {
  const updated = updateCoverage(
    coverage("test"),
    testIdentity("test"),
    "next",
    [
      "fail",
      "pass",
      "infra_failure",
      "pass",
    ],
  );
  equal(updated.last_pass, "next");
  equal(updated.last_revision, "next");
  equal(updated.pending, false);
  equal(updated.flake_passes, 14);
  equal(updated.flake_failures, 2);
  equal(selectCoverage({ test: updated }, [], "after", 10).inherited, [
    updated,
  ]);
});

Deno.test("coverage infra-only or empty cohorts remain pending without inventing test outcomes", () => {
  for (
    const observations of [[], ["infra_failure"]] as ObservationOutcome[][]
  ) {
    const updated = updateCoverage(
      coverage("test"),
      testIdentity("test"),
      "infra",
      observations,
    );
    equal(updated.last_pass, "rev-before");
    equal(updated.last_revision, "infra");
    equal(updated.pending, true);
    equal(updated.flake_passes, 12);
    equal(updated.flake_failures, 1);
    const selection = selectCoverage({ test: updated }, [], "retry", 1);
    equal(selection.inherited, []);
    equal(selection.selected, [testIdentity("test")]);
  }
});

Deno.test("coverage changed infra-failed test cannot retain an old lineage baseline", () => {
  const updated = updateCoverage(
    coverage("test"),
    testIdentity("test", true),
    "changed",
    [
      "infra_failure",
    ],
  );
  equal(updated.last_pass, null);
  equal(updated.pending, true);
  equal(updated.flake_passes, 0);
  equal(updated.flake_failures, 0);
});

Deno.test("coverage does not transfer evidence between different test identities", () => {
  const updated = updateCoverage(coverage("old"), testIdentity("new"), "next", [
    "fail",
  ]);
  equal(updated.last_pass, null);
  equal(updated.flake_passes, 0);
  equal(updated.flake_failures, 1);
});

Deno.test("coverage updates do not mutate their inputs and replay from one snapshot is stable", () => {
  const prior = coverage("test");
  const test = testIdentity("test");
  const outcomes: ObservationOutcome[] = ["pass", "fail"];
  const before = JSON.stringify({ prior, test, outcomes });
  const first = updateCoverage(prior, test, "next", outcomes);
  const replay = updateCoverage(prior, test, "next", outcomes);
  equal(first, replay);
  equal(JSON.stringify({ prior, test, outcomes }), before);
});

Deno.test("flake estimate starts with a one-percent prior and clamps deterministic or noisy history", () => {
  equal(flakeRate(undefined), 0.01);
  equal(
    flakeRate(coverage("new", { flake_passes: 0, flake_failures: 0 })),
    0.01,
  );
  equal(
    flakeRate(coverage("clean", { flake_passes: 10000, flake_failures: 0 })),
    0.01,
  );
  equal(
    flakeRate(coverage("noisy", { flake_passes: 0, flake_failures: 10000 })),
    0.5,
  );
  equal(
    flakeRate(coverage("mixed", { flake_passes: 80, flake_failures: 20 })),
    21 / 200,
  );
});

Deno.test("flake estimate rejects corrupt counters instead of passing NaN to FACF", () => {
  for (const count of [-1, NaN, Infinity, 0.5]) {
    let threw = false;
    try {
      flakeRate(coverage("test", { flake_failures: count }));
    } catch {
      threw = true;
    }
    assert(threw);
  }
});

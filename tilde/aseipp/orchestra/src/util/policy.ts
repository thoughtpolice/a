// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * Pure TAP-style coverage, throttling, and deflaking policy for Orchestra.
 *
 * Repository actors persist the coverage ledger; Workflows use these functions
 * to choose a bounded epoch, interpret repeated test executions, and estimate
 * the noise rate for a separate FACF investigation. None of these functions
 * performs I/O, mutates its inputs, schedules jobs, or treats inherited coverage
 * as a fresh test execution. Buck/tdutil supplies stable identities and the
 * affected set; it remains responsible for the build graph and execution.
 *
 * @module
 */

/** The tdutil identity and change flag needed by coverage policy. */
export interface TestIdentity {
  /** Stable identity within one test lineage, shared across epochs. */
  test_key: string;
  /** Buck target label for execution and human-readable reporting. */
  label: string;
  /** Logical execution platform; scheduling must preserve this constraint. */
  platform: string;
  /** Whether this epoch changes the test itself, invalidating earlier evidence. */
  changed: boolean;
}

/** Durable coverage evidence for one test identity, maintained by the caller. */
export interface CoverageEntry {
  /** Stable identity used as the ledger key. */
  test_key: string;
  /** Latest known Buck label for this identity. */
  label: string;
  /** Latest known logical execution platform for this identity. */
  platform: string;
  /** Most recent revision with an actual passing execution, or no baseline. */
  last_pass: string | null;
  /** Revision of the latest observation cohort, including unsuccessful cohorts. */
  last_revision: string | null;
  /** Coverage is invalidated or still awaiting a usable execution result. */
  pending: boolean;
  /** Actual passing executions in this unchanged test lineage. */
  flake_passes: number;
  /** Actual failing executions in this unchanged test lineage, not infra errors. */
  flake_failures: number;
}

/** A real execution outcome; transport/redelivery events are not observations. */
export type ObservationOutcome = "pass" | "fail" | "infra_failure";

/** Deflaked interpretation of one cohort of independent test executions. */
export type ObservationClassification =
  | "pass"
  | "flaky"
  | "fail"
  | "infra_failure";

/** Bounded epoch work and coverage that remains valid without re-execution. */
export interface CoverageSelection {
  /** Affected or previously pending tests selected for this epoch's budget. */
  selected: TestIdentity[];
  /** Remaining affected/pending tests; these must not be reported as green. */
  deferred: TestIdentity[];
  /** Untouched, non-pending tests whose latest usable cohort passed. */
  inherited: CoverageEntry[];
}

/**
 * Selects a deterministic, bounded union of affected and previously pending tests.
 *
 * Current affected identities override earlier label/platform metadata. A
 * carried pending test has `changed: false` unless the current affected set
 * says otherwise. Every affected test is logically invalidated, even if it
 * had passed before, and is excluded from inherited coverage. Untouched tests
 * inherit only when their latest observation revision equals their last pass.
 *
 * This returns a plan, not an updated ledger: before publishing it, the caller
 * must durably mark all selected/deferred candidates pending at `revision`,
 * and clear changed-test baselines through its normal invalidation path.
 * Deferring work never establishes coverage. `revision` identifies that epoch
 * but is not compared lexically: commit IDs have no lexical chronology.
 */
export function selectCoverage(
  known: Record<string, CoverageEntry>,
  affected: readonly TestIdentity[],
  revision: string,
  maxTests: number,
): CoverageSelection {
  if (!revision) throw new RangeError("revision must not be empty");
  if (!Number.isSafeInteger(maxTests) || maxTests < 0) {
    throw new RangeError("maxTests must be a non-negative safe integer");
  }
  const candidates = new Map<string, TestIdentity>();
  for (const entry of Object.values(known)) {
    if (entry.pending) {
      candidates.set(entry.test_key, {
        test_key: entry.test_key,
        label: entry.label,
        platform: entry.platform,
        changed: false,
      });
    }
  }
  // Current affected entries are authoritative; OR repeated change flags so
  // an accidentally repeated identity cannot hide test-definition changes.
  const current = new Map<string, TestIdentity>();
  for (const test of affected) {
    const earlier = current.get(test.test_key);
    if (
      earlier &&
      (earlier.label !== test.label || earlier.platform !== test.platform)
    ) {
      throw new Error(`conflicting affected test identity: ${test.test_key}`);
    }
    current.set(test.test_key, {
      ...test,
      changed: test.changed || earlier?.changed === true,
    });
  }
  for (const [key, test] of current) candidates.set(key, test);
  const ordered = [...candidates.values()].sort((left, right) =>
    left.test_key < right.test_key ? -1 : left.test_key > right.test_key ? 1 : 0
  );
  const inherited = Object.values(known)
    .filter((entry) =>
      !candidates.has(entry.test_key) && !entry.pending &&
      entry.last_pass !== null &&
      entry.last_revision === entry.last_pass
    )
    .sort((left, right) =>
      left.test_key < right.test_key
        ? -1
        : left.test_key > right.test_key
        ? 1
        : 0
    )
    .map((entry) => ({ ...entry }));
  return {
    selected: ordered.slice(0, maxTests),
    deferred: ordered.slice(maxTests),
    inherited,
  };
}

/**
 * Estimates test failure noise with a Beta(1,99) prior, clamped to [0.01, 0.5].
 *
 * A new lineage starts at one percent. The estimate uses genuine observations
 * only; callers must not include infra failures or inherited coverage. These
 * counters measure observed failure frequency, not proven intrinsic flakiness:
 * real regressions also fail. Freeze the pre-investigation estimate for FACF
 * instead of adapting its noise model to the very failures it is explaining.
 */
export function flakeRate(entry: CoverageEntry | undefined): number {
  const passes = entry?.flake_passes ?? 0;
  const failures = entry?.flake_failures ?? 0;
  if (
    !Number.isSafeInteger(passes) || passes < 0 ||
    !Number.isSafeInteger(failures) || failures < 0
  ) {
    throw new RangeError("flake counters must be non-negative safe integers");
  }
  return Math.max(
    0.01,
    Math.min(0.5, (failures + 1) / (passes + failures + 100)),
  );
}

/**
 * Interprets a deflaking cohort without confusing infrastructure with test failure.
 *
 * At least one PASS and FAIL means flaky; only PASS means pass; only FAIL means
 * fail. Infra errors do not vote either way. Empty and entirely infra-failed
 * cohorts remain infra_failure, never a successful test run.
 */
export function classifyObservations(
  outcomes: readonly ObservationOutcome[],
): ObservationClassification {
  const passed = outcomes.includes("pass");
  const failed = outcomes.includes("fail");
  if (passed && failed) return "flaky";
  if (passed) return "pass";
  if (failed) return "fail";
  return "infra_failure";
}

/**
 * Applies one completed execution cohort to a test's coverage record.
 *
 * Changed tests (or a different identity) start a new lineage: prior passing
 * baselines and observation counters are discarded. A pass/flaky cohort has
 * an actual pass at this revision and advances `last_pass`; an all-failing
 * cohort preserves the earlier baseline but advances `last_revision`, making
 * it ineligible for inherited green coverage. All-infra/empty cohorts retain
 * any valid baseline yet remain pending. Infrastructure contributes no counts.
 *
 * The caller must deduplicate completion delivery and call this once per
 * independent cohort, or replay it from the same pre-cohort snapshot. Replaying
 * against its own result would double-count evidence.
 */
export function updateCoverage(
  prior: CoverageEntry | undefined,
  test: TestIdentity,
  revision: string,
  observations: readonly ObservationOutcome[],
): CoverageEntry {
  if (!revision) throw new RangeError("revision must not be empty");
  const baseline = !test.changed && prior?.test_key === test.test_key
    ? prior
    : undefined;
  const classification = classifyObservations(observations);
  return {
    test_key: test.test_key,
    label: test.label,
    platform: test.platform,
    last_pass: classification === "pass" || classification === "flaky"
      ? revision
      : baseline?.last_pass ?? null,
    last_revision: revision,
    pending: classification === "infra_failure",
    flake_passes: (baseline?.flake_passes ?? 0) +
      observations.filter((outcome) => outcome === "pass").length,
    flake_failures: (baseline?.flake_failures ?? 0) +
      observations.filter((outcome) => outcome === "fail").length,
  };
}

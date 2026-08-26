// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0
/**
 * Pure scheduling-boundary tests: immutable checkpoint deadlines, clock
 * corrections, and malformed metadata. The actual Workflow wrapper and
 * multi-hour virtual runs are tested separately. @module
 */
import {
  EPOCH_DEADLINE_ERROR,
  EPOCH_TIMEOUT_MS,
  MAX_IMMEDIATE_ACTIVITIES,
  MAX_RECONCILIATION_ACTIVITIES,
  ReconciliationBudget,
  type SchedulingCheckpoint,
} from "./scheduling.ts";
import { assert, assertEquals } from "./testing.ts";

/** A live epoch checkpoint independent of the real clock or runtime. */
function checkpoint(observed_at = 0): SchedulingCheckpoint {
  return {
    done: false,
    wait: true,
    observed_at,
    deadline_at: EPOCH_TIMEOUT_MS,
  };
}

/** Requires an explicit safety failure, never silent budget replenishment. */
function rejects(operation: () => unknown, message: string): void {
  try {
    operation();
  } catch (error) {
    assert(error instanceof Error);
    assertEquals(error.message, message);
    return;
  }
  throw new Error(`expected ${message}`);
}

Deno.test("checkpoints cannot move the deadline or replenish time on clock rollback", () => {
  const budget = new ReconciliationBudget();
  assertEquals(budget.next(checkpoint(10_000)), EPOCH_TIMEOUT_MS - 10_000);
  assertEquals(budget.next(checkpoint(1_000)), EPOCH_TIMEOUT_MS - 10_000);
  rejects(
    () =>
      budget.next({ ...checkpoint(20_000), deadline_at: EPOCH_TIMEOUT_MS + 1 }),
    "invalid Workflow scheduling checkpoint",
  );
  rejects(
    () => budget.next(checkpoint(EPOCH_TIMEOUT_MS)),
    EPOCH_DEADLINE_ERROR,
  );
});

Deno.test("missing, partial, or invalid scheduling metadata fails closed", () => {
  for (
    const invalid of [
      { done: false, wait: true },
      { done: false, wait: true, observed_at: 0 },
      { done: false, wait: true, deadline_at: EPOCH_TIMEOUT_MS },
      { ...checkpoint(), done: undefined },
      { ...checkpoint(), wait: undefined },
      { ...checkpoint(), observed_at: NaN },
      { ...checkpoint(), observed_at: -1 },
      { ...checkpoint(), observed_at: Infinity },
      { ...checkpoint(), deadline_at: 1.5 },
    ]
  ) {
    rejects(
      () =>
        new ReconciliationBudget().next(
          invalid as unknown as SchedulingCheckpoint,
        ),
      "invalid Workflow scheduling checkpoint",
    );
  }
});

Deno.test("the final wait is capped to the deadline, which then expires", () => {
  const budget = new ReconciliationBudget();
  for (let round = 0; round < 10; round++) {
    budget.next(checkpoint(round * 30_000));
  }
  assertEquals(budget.next(checkpoint(EPOCH_TIMEOUT_MS - 1)), 1);
  rejects(
    () => budget.next(checkpoint(EPOCH_TIMEOUT_MS)),
    EPOCH_DEADLINE_ERROR,
  );
});

Deno.test("terminal checkpoints are rejected rather than bounding another wait", () => {
  // EpochWorkflow returns terminal results before consulting the budget, so
  // terminal truth wins over the deadline and exhausted guards there.
  rejects(
    () =>
      new ReconciliationBudget().next({
        ...checkpoint(EPOCH_TIMEOUT_MS + 1),
        done: true,
        wait: false,
      }),
    "invalid Workflow scheduling checkpoint",
  );
});

Deno.test("the total safety guard admits a full day of one-second wakes", () => {
  assert(
    MAX_RECONCILIATION_ACTIVITIES >
      EPOCH_TIMEOUT_MS / 1_000 + MAX_IMMEDIATE_ACTIVITIES,
  );
});

// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0
/**
 * Pure scheduling-boundary tests: immutable checkpoint deadlines, clock
 * corrections, malformed metadata, and legacy replay. The actual Workflow
 * wrapper and multi-hour virtual runs are tested separately. @module
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
    changed: false,
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

Deno.test("polling checkpoints cannot move the deadline or replenish time on clock rollback", () => {
  const budget = new ReconciliationBudget();
  assertEquals(
    budget.next(checkpoint(10_000)).remaining_ms,
    EPOCH_TIMEOUT_MS - 10_000,
  );
  assertEquals(
    budget.next(checkpoint(1_000)).remaining_ms,
    EPOCH_TIMEOUT_MS - 10_000,
  );
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

Deno.test("partial or invalid polling metadata fails closed rather than taking the legacy path", () => {
  for (
    const invalid of [
      { done: false, wait: true, changed: false },
      { ...checkpoint(), observed_at: NaN },
      { ...checkpoint(), observed_at: -1 },
      { ...checkpoint(), observed_at: Infinity },
      { ...checkpoint(), deadline_at: 1.5 },
    ]
  ) {
    rejects(
      () => new ReconciliationBudget().next(invalid),
      "invalid Workflow scheduling checkpoint",
    );
  }
});

Deno.test("polling caps its final sleep to a positive millisecond and then expires", () => {
  const budget = new ReconciliationBudget();
  for (let round = 0; round < 10; round++) {
    budget.next(checkpoint(round * 30_000));
  }
  assertEquals(budget.next(checkpoint(EPOCH_TIMEOUT_MS - 1)), {
    delay_ms: 1,
    remaining_ms: 1,
  });
  rejects(
    () => budget.next(checkpoint(EPOCH_TIMEOUT_MS)),
    EPOCH_DEADLINE_ERROR,
  );
});

Deno.test("legacy polling retains names' one-second duration until fresh scheduling metadata", () => {
  const budget = new ReconciliationBudget();
  for (let round = 0; round < 10_001; round++) {
    assertEquals(budget.next({ done: false, wait: true }), {
      delay_ms: 1_000,
      remaining_ms: null,
    });
  }
  const start = 10_001_000;
  assertEquals(budget.next(checkpoint(start)).delay_ms, 1_000);
  assertEquals(budget.next(checkpoint(start + 1_000)).delay_ms, 2_000);
});

Deno.test("terminal truth takes priority over scheduling metadata and exhausted guards", () => {
  const budget = new ReconciliationBudget();
  for (let round = 0; round < MAX_IMMEDIATE_ACTIVITIES - 1; round++) {
    budget.next({ ...checkpoint(), wait: false, changed: true });
  }
  assertEquals(
    budget.next({
      done: true,
      wait: false,
      changed: false,
      observed_at: EPOCH_TIMEOUT_MS + 1,
      deadline_at: EPOCH_TIMEOUT_MS,
    }),
    { delay_ms: 0, remaining_ms: null },
  );
  assert(
    MAX_RECONCILIATION_ACTIVITIES >
      EPOCH_TIMEOUT_MS / 1_000 + MAX_IMMEDIATE_ACTIVITIES,
  );
});

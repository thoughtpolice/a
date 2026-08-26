// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0
/**
 * Replay-deterministic Workflow deadlines and safety limits. Decisions consume
 * activity checkpoints, never the ambient clock: celld may replay completed
 * steps long after their original execution. Waiting has a time budget;
 * immediately runnable reconciliation has an independent activity budget.
 * This module neither waits nor changes domain state. @module
 */

/** Existing epoch lifetime, measured from reservation creation, not agent claim. */
export const EPOCH_TIMEOUT_MS = 24 * 60 * 60 * 1000;
/** Stable operational failure, never a test observation or a fabricated culprit. */
export const EPOCH_DEADLINE_ERROR = "epoch execution deadline exceeded (24h)";
/**
 * How long a waiting Workflow sleeps on its result event before reconciling
 * anyway: the tick that covers a lost or dead-lettered notification.
 */
export const WAKE_TIMEOUT_MS = 60_000;
/** celld rejects shorter event timeouts; a nearer deadline is a plain sleep. */
export const MIN_EVENT_TIMEOUT_MS = 1_000;
/** Independent guard against immediately runnable reconciliation failing to converge. */
export const MAX_IMMEDIATE_ACTIVITIES = 10_000;
/**
 * Defensive ceiling for frozen clocks or an event-delivery storm. A wake every
 * second for the entire epoch, plus every permitted immediate activity and a
 * final deadline check, fits; ordinary waits need far fewer records.
 */
export const MAX_RECONCILIATION_ACTIVITIES = MAX_IMMEDIATE_ACTIVITIES +
  Math.ceil(EPOCH_TIMEOUT_MS / MIN_EVENT_TIMEOUT_MS) + 1;

/** Small persisted activity result; every activity records all four fields. */
export interface SchedulingCheckpoint {
  /** Terminal domain state wins even when publication is replayed after expiry. */
  done: boolean;
  /** False means another activity can make progress without waiting for an agent. */
  wait: boolean;
  /** Wall clock observed inside the completed activity, persisted by step.do. */
  observed_at: number;
  /** Stable reservation creation time plus EPOCH_TIMEOUT_MS. */
  deadline_at: number;
}

/** Local counters are reconstructed from the same cached activity results on replay. */
export class ReconciliationBudget {
  #activities = 0;
  #immediate = 0;
  #deadline: number | undefined;
  #observed = 0;

  /**
   * Account for one completed, non-terminal activity and return the remaining
   * epoch lifetime, which bounds its next wait. Callers return terminal results
   * before accounting for them, so a terminal checkpoint here is malformed.
   */
  next(progress: SchedulingCheckpoint): number {
    if (
      progress.done !== false || typeof progress.wait !== "boolean" ||
      !Number.isSafeInteger(progress.observed_at) ||
      progress.observed_at < 0 ||
      !Number.isSafeInteger(progress.deadline_at) ||
      progress.deadline_at < 0 ||
      (this.#deadline !== undefined && this.#deadline !== progress.deadline_at)
    ) throw new Error("invalid Workflow scheduling checkpoint");
    this.#deadline = progress.deadline_at;
    // A backwards clock correction must not replenish an observed time budget.
    this.#observed = Math.max(this.#observed, progress.observed_at);
    const remaining = this.#deadline - this.#observed;
    if (remaining <= 0) throw new Error(EPOCH_DEADLINE_ERROR);
    if (++this.#activities >= MAX_RECONCILIATION_ACTIVITIES) {
      throw new Error("Workflow total activity safety limit exhausted");
    }
    if (!progress.wait && ++this.#immediate >= MAX_IMMEDIATE_ACTIVITIES) {
      throw new Error("Workflow immediate reconciliation budget exhausted");
    }
    return remaining;
  }
}

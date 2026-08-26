// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0
/**
 * Replay-deterministic Workflow pacing and safety limits. Decisions consume
 * activity checkpoints, never the ambient clock: celld may replay completed
 * steps long after their original execution. Idle polls have a time budget;
 * immediately runnable reconciliation has an independent activity budget.
 * This module neither sleeps nor changes domain state. @module
 */

/** Existing epoch lifetime, measured from reservation creation, not agent claim. */
export const EPOCH_TIMEOUT_MS = 24 * 60 * 60 * 1000;
/** Stable operational failure, never a test observation or a fabricated culprit. */
export const EPOCH_DEADLINE_ERROR = "epoch execution deadline exceeded (24h)";
/** First idle poll and minimum ordinary wait, preserving fast local feedback. */
export const MIN_POLL_DELAY_MS = 1_000;
/** Long-running work trades at most thirty seconds of pickup latency for fewer polls. */
export const MAX_POLL_DELAY_MS = 30_000;
/** Independent guard against immediately runnable reconciliation failing to converge. */
export const MAX_IMMEDIATE_ACTIVITIES = 10_000;
/**
 * Defensive ceiling for frozen clocks or an experimental event-delivery storm.
 * Even one-second polling for the entire epoch, plus every permitted immediate
 * activity and a final deadline check, fits. Ordinary idle backoff needs far
 * fewer records, and this ceiling cannot reproduce the old 2.8-hour limit.
 */
export const MAX_RECONCILIATION_ACTIVITIES = MAX_IMMEDIATE_ACTIVITIES +
  Math.ceil(EPOCH_TIMEOUT_MS / MIN_POLL_DELAY_MS) + 1;

/**
 * Small persisted activity result. Scheduling fields are optional only to read
 * pre-upgrade completed steps; fresh activities return all three together.
 */
export interface SchedulingCheckpoint {
  /** Terminal domain state wins even when publication is replayed after expiry. */
  done: boolean;
  /** False means another activity can make progress without waiting for an agent. */
  wait: boolean;
  /** Semantic progress, excluding generation bumps, notifications, and heartbeats. */
  changed?: boolean;
  /** Wall clock observed inside the completed activity, persisted by step.do. */
  observed_at?: number;
  /** Stable reservation creation time plus EPOCH_TIMEOUT_MS. */
  deadline_at?: number;
}

/** Pacing decision; zero means reconcile immediately and never issue a zero sleep. */
export interface SchedulingDecision {
  /** Requested polling duration, already capped to the checkpoint's remaining time. */
  delay_ms: number;
  /** Remaining epoch lifetime; null only while replaying legacy checkpoints. */
  remaining_ms: number | null;
}

/** Local counters are reconstructed from the same cached activity results on replay. */
export class ReconciliationBudget {
  #activities = 0;
  #immediate = 0;
  #idleRounds = 0;
  #deadline: number | undefined;
  #observed = 0;

  /**
   * Account for one completed activity and choose its next wait. Legacy results
   * preserve the old one-second step duration and names; the first uncached
   * activity checks the real deadline before doing work after an outage.
   */
  next(progress: SchedulingCheckpoint): SchedulingDecision {
    if (
      typeof progress.done !== "boolean" || typeof progress.wait !== "boolean"
    ) {
      throw new Error("invalid Workflow scheduling checkpoint");
    }
    if (progress.done) return { delay_ms: 0, remaining_ms: null };
    const legacy = progress.changed === undefined &&
      progress.observed_at === undefined &&
      progress.deadline_at === undefined;
    let remaining: number | null = null;
    if (!legacy) {
      if (
        typeof progress.changed !== "boolean" ||
        !Number.isSafeInteger(progress.observed_at) ||
        progress.observed_at! < 0 ||
        !Number.isSafeInteger(progress.deadline_at) ||
        progress.deadline_at! < 0 ||
        (this.#deadline !== undefined &&
          this.#deadline !== progress.deadline_at)
      ) throw new Error("invalid Workflow scheduling checkpoint");
      this.#deadline = progress.deadline_at!;
      // A backwards clock correction must not replenish an observed time budget.
      this.#observed = Math.max(this.#observed, progress.observed_at!);
      remaining = this.#deadline - this.#observed;
      if (remaining <= 0) throw new Error(EPOCH_DEADLINE_ERROR);
    }
    if (++this.#activities >= MAX_RECONCILIATION_ACTIVITIES) {
      throw new Error("Workflow total activity safety limit exhausted");
    }
    if (!progress.wait) {
      this.#idleRounds = 0;
      if (++this.#immediate >= MAX_IMMEDIATE_ACTIVITIES) {
        throw new Error("Workflow immediate reconciliation budget exhausted");
      }
      return { delay_ms: 0, remaining_ms: remaining };
    }
    if (legacy) {
      this.#idleRounds = 0;
      return { delay_ms: MIN_POLL_DELAY_MS, remaining_ms: null };
    }
    if (progress.changed) this.#idleRounds = 0;
    const duration = Math.min(
      MAX_POLL_DELAY_MS,
      MIN_POLL_DELAY_MS * 2 ** this.#idleRounds,
    );
    if (!progress.changed) this.#idleRounds = Math.min(this.#idleRounds + 1, 5);
    return {
      delay_ms: Math.min(duration, remaining!),
      remaining_ms: remaining,
    };
  }
}

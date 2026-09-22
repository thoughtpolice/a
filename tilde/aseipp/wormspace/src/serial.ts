// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * Two small disciplines for code that calls other cells: one call at a time
 * per instance, and bounded repetition of calls celld says are safe to repeat.
 *
 * A Durable Object's methods interleave at every `await`, so a method that
 * reads its meta, calls a segment, and writes its meta back would race a
 * second call on the same instance. `Serial` funnels every such method
 * through one promise chain instead: each call starts when the previous one
 * settles, and a rejection is handed to its own caller and never poisons the
 * chain. The chain is not state: an evicted instance loses it together with
 * the calls waiting on it, whose callers see a transport error.
 *
 * `retryTransient` repeats a call that threw one of celld's retryable errors
 * (`retryableCause` in `http.ts`) a bounded number of times, and throws the
 * last error when the budget runs out. Callers use it only for calls that are
 * safe to repeat: reads, captures (a repeated capture is a later round of the
 * same holder), write replays with identical bytes, and the sequencer's
 * `next`. A repeated `next` after an ambiguous failure issues another slot and
 * can leave the first one `pending` for `fill`; it never writes a record twice.
 *
 * @module
 */

import { retryableCause } from "./http.ts";

/** A per-instance queue: `run` starts `task` once all earlier ones settle. */
export class Serial {
  #tail: Promise<unknown> = Promise.resolve();

  run<T>(task: () => Promise<T>): Promise<T> {
    const result = this.#tail.then(task);
    this.#tail = result.catch(() => undefined);
    return result;
  }
}

/** How hard `retryTransient` tries. */
export interface RetryPolicy {
  /** Calls in all, the first included. */
  attempts: number;
  /** Pause between calls; 0 in tests. */
  pauseMs: number;
}

export const DEFAULT_RETRY: RetryPolicy = { attempts: 5, pauseMs: 100 };

/** The most calls a policy may make, and the longest base pause. */
export const RETRY_LIMITS = { attempts: 20, pauseMs: 10_000 } as const;

/**
 * A frozen copy of `policy`, or a `RangeError`. `attempts` must be a whole
 * number from 1 to 20 and `pauseMs` a finite number from 0 to 10,000: a
 * `NaN` or infinite `attempts` would retry a persistent transient failure
 * forever, and a `NaN` pause would retry it back to back.
 */
export function checkRetryPolicy(policy: RetryPolicy): RetryPolicy {
  const { attempts, pauseMs } = policy;
  if (
    !Number.isSafeInteger(attempts) || attempts < 1 ||
    attempts > RETRY_LIMITS.attempts
  ) {
    throw new RangeError(
      `retry attempts must be a whole number from 1 to ${RETRY_LIMITS.attempts}, not ${attempts}`,
    );
  }
  if (
    !Number.isFinite(pauseMs) || pauseMs < 0 || pauseMs > RETRY_LIMITS.pauseMs
  ) {
    throw new RangeError(
      `retry pauseMs must be from 0 to ${RETRY_LIMITS.pauseMs}, not ${pauseMs}`,
    );
  }
  return Object.freeze({ attempts, pauseMs });
}

/** Whether celld said this failure is safe to repeat. */
export function isTransient(error: unknown): boolean {
  return retryableCause(error) !== null;
}

function pause(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Calls `call`, repeating it after a transient throw, `attempts` at most.
 * The policy is checked first ({@link checkRetryPolicy}).
 */
export async function retryTransient<T>(
  call: () => Promise<T>,
  retry: RetryPolicy = DEFAULT_RETRY,
): Promise<T> {
  const policy = checkRetryPolicy(retry);
  for (let attempt = 1;; attempt += 1) {
    try {
      return await call();
    } catch (error) {
      if (!isTransient(error) || attempt >= policy.attempts) throw error;
    }
    if (policy.pauseMs > 0) await pause(policy.pauseMs * attempt);
  }
}

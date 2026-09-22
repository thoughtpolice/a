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
 * same holder), and write replays with identical bytes.
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

/** Whether celld said this failure is safe to repeat. */
export function isTransient(error: unknown): boolean {
  return retryableCause(error) !== null;
}

function pause(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Calls `call`, repeating it after a transient throw, `attempts` at most. */
export async function retryTransient<T>(
  call: () => Promise<T>,
  policy: RetryPolicy = DEFAULT_RETRY,
): Promise<T> {
  for (let attempt = 1;; attempt += 1) {
    try {
      return await call();
    } catch (error) {
      if (!isTransient(error) || attempt >= policy.attempts) throw error;
    }
    if (policy.pauseMs > 0) await pause(policy.pauseMs * attempt);
  }
}

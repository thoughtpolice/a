// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * The two things an HTTP client takes as parameters so that tests need no
 * network and no waiting: a `fetch`, and a clock with randomness.
 *
 * @module
 */

import { MAX_TIMER_MS } from "@celld/core/bounds";

/**
 * A `fetch` compatible with the global one, so `fetch` itself, a service
 * binding's `fetch`, or a test double all fit. The clients here always call
 * it with a URL string and an init, but a double must accept what `fetch`
 * accepts.
 */
export type FetchLike = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

/** The global `fetch`, looked up at call time so tests may replace it. */
export const globalFetch: FetchLike = (input, init) => fetch(input, init);

/** Time and randomness, injectable so tests need not wait. */
export interface Runtime {
  /** Milliseconds since the epoch. */
  now(): number;
  /** A number in [0, 1), for jitter. */
  random(): number;
  /**
   * Resolves after `ms`, or rejects with the signal's reason when it aborts.
   * {@link defaultRuntime} rejects with a `RangeError` for a delay that is
   * not a number from 0 to `MAX_TIMER_MS`.
   */
  sleep(ms: number, signal?: AbortSignal): Promise<void>;
  /**
   * Calls `callback` after `ms`; the result cancels it. {@link
   * defaultRuntime} throws a `RangeError` for a delay that is not a number
   * from 0 to `MAX_TIMER_MS`.
   */
  setTimer(ms: number, callback: () => void): () => void;
}

// setTimeout runs a NaN, negative or too-large delay at once, which turns a
// bad wait into a tight loop.
function timerDelay(ms: number): number {
  if (
    typeof ms !== "number" || Number.isNaN(ms) || ms < 0 || ms > MAX_TIMER_MS
  ) {
    throw new RangeError(
      `a timer delay must be a number from 0 to ${MAX_TIMER_MS} ms, got ${ms}`,
    );
  }
  return ms;
}

/**
 * Real time: `Date.now`, `Math.random` and `setTimeout`. `sleep` and
 * `setTimer` refuse delays outside 0 to `MAX_TIMER_MS` (a `RangeError`),
 * which `setTimeout` would otherwise run at once.
 */
export const defaultRuntime: Runtime = Object.freeze({
  now: () => Date.now(),
  random: () => Math.random(),
  sleep(ms: number, signal?: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      try {
        timerDelay(ms);
      } catch (error) {
        reject(error);
        return;
      }
      if (signal?.aborted) {
        reject(signal.reason);
        return;
      }
      const onAbort = () => {
        clearTimeout(timer);
        reject(signal!.reason);
      };
      const timer = setTimeout(() => {
        signal?.removeEventListener("abort", onAbort);
        resolve();
      }, ms);
      signal?.addEventListener("abort", onAbort, { once: true });
    });
  },
  setTimer(ms: number, callback: () => void): () => void {
    const timer = setTimeout(callback, timerDelay(ms));
    return () => clearTimeout(timer);
  },
});

/**
 * Settles like `promise`, but rejects with the signal's reason as soon as
 * `signal` aborts, so a `fetch` (or a body read) that ignores its signal
 * still cannot outlive a timeout.
 */
export function rejectOnAbort<T>(
  promise: Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    if (signal.aborted) {
      // The caller already started this operation. Observe its rejection even
      // when our signal won before subscription (no unhandled rejection).
      promise.catch(() => {});
      reject(signal.reason);
      return;
    }
    const onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(resolve, reject).finally(() =>
      signal.removeEventListener("abort", onAbort)
    );
  });
}

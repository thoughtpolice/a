// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * The two things an HTTP client takes as parameters so that tests need no
 * network and no waiting: a `fetch`, and a clock with randomness.
 *
 * @module
 */

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
  /** Resolves after `ms`, or rejects with the signal's reason when it aborts. */
  sleep(ms: number, signal?: AbortSignal): Promise<void>;
  /** Calls `callback` after `ms`; the result cancels it. */
  setTimer(ms: number, callback: () => void): () => void;
}

/** Real time: `Date.now`, `Math.random` and `setTimeout`. */
export const defaultRuntime: Runtime = Object.freeze({
  now: () => Date.now(),
  random: () => Math.random(),
  sleep(ms: number, signal?: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
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
    const timer = setTimeout(callback, ms);
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

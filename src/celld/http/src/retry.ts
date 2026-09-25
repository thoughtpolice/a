// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * When and how long an HTTP client waits before trying again.
 *
 * The library has no default policy. Each client owns its defaults and passes
 * them to {@link resolveRetryPolicy}. A policy is the backoff, budget and
 * server-requested waits of {@link RetryPolicy}, plus whatever the client
 * decides on. {@link HttpRetryPolicy} adds status codes and the two kinds of
 * missing responses. A client that classifies failures into its own kinds
 * extends {@link RetryPolicy} with a list of them instead.
 *
 * @module
 */

/** The fields every retry policy has. */
export interface RetryPolicy {
  /** Retries after the first attempt; 0 disables retrying. */
  readonly maxRetries: number;
  /** The first backoff delay, doubled for each retry. */
  readonly backoffInitialMs: number;
  /** The largest backoff delay. */
  readonly backoffMaxMs: number;
  /**
   * The fraction of each backoff delay randomly subtracted, from 0 (none) to
   * 1 ("full jitter", a uniform delay between 0 and the backoff).
   */
  readonly backoffJitter: number;
  /** Whether to wait as `retry-after-ms` / `retry-after` ask, when present. */
  readonly respectRetryAfter: boolean;
  /** The longest server-requested wait honoured; longer ones are capped. */
  readonly maxRetryAfterMs: number;
  /**
   * Total time for one call, including every attempt, backoff and limiter
   * wait. A retry whose wait would reach it is not started; `null` disables.
   */
  readonly budgetMs: number | null;
}

/** A policy that decides by HTTP status and by how an attempt failed. */
export interface HttpRetryPolicy extends RetryPolicy {
  /** HTTP statuses retried, sorted and without duplicates once resolved. */
  readonly statuses: readonly number[];
  /** Whether to retry when no response arrives. */
  readonly retryConnectionErrors: boolean;
  /** Whether to retry an attempt that timed out on the client. */
  readonly retryTimeouts: boolean;
}

/**
 * A partial policy, as clients accept it: any subset of `P`'s fields, where
 * a list may be given as any iterable. `undefined` means "the default".
 */
export type RetryOptions<P extends RetryPolicy = HttpRetryPolicy> = {
  readonly [K in keyof P]?: P[K] extends readonly (infer T)[] ? Iterable<T>
    : P[K];
};

const NUMBERS: readonly [keyof RetryPolicy, number, number][] = [
  ["backoffInitialMs", 0, Number.POSITIVE_INFINITY],
  ["backoffMaxMs", 0, Number.POSITIVE_INFINITY],
  ["backoffJitter", 0, 1],
  ["maxRetryAfterMs", 0, Number.POSITIVE_INFINITY],
];

function checkNumber(key: string, value: unknown, low: number, high: number) {
  if (
    typeof value !== "number" || !Number.isFinite(value) || value < low ||
    value > high
  ) {
    throw new RangeError(
      `retry.${key} must be a finite number from ${low}${
        high === Number.POSITIVE_INFINITY ? "" : ` to ${high}`
      }, got ${value}`,
    );
  }
}

function checkList(key: string, value: unknown): readonly unknown[] {
  if (
    typeof value !== "object" || value === null ||
    typeof (value as Iterable<unknown>)[Symbol.iterator] !== "function"
  ) {
    throw new RangeError(`retry.${key} must be iterable, got ${value}`);
  }
  const items = [...new Set(value as Iterable<unknown>)];
  if (key !== "statuses") return Object.freeze(items);
  const statuses: number[] = [];
  for (const status of items) {
    if (
      typeof status !== "number" || !Number.isInteger(status) ||
      status < 100 || status > 599
    ) {
      throw new RangeError(`retry.statuses has a non-status ${status}`);
    }
    statuses.push(status);
  }
  return Object.freeze(statuses.sort((a, b) => a - b));
}

/**
 * Fills a partial policy from the client's `defaults` and checks it.
 *
 * Only the fields of `defaults` are kept; an option that is `undefined`
 * takes the default. Numbers must be finite and in range, `maxRetries` a
 * non-negative integer, `budgetMs` at least 1 or `null`, and a field whose
 * default is a boolean must be a boolean. A field whose default is an array
 * accepts any iterable and loses duplicates; `statuses` must also hold HTTP
 * statuses (100 to 599) and comes back sorted. Other fields a client adds
 * are copied as given. The result and its lists are frozen.
 *
 * @throws {RangeError} naming the first bad field.
 */
export function resolveRetryPolicy<P extends RetryPolicy>(
  options: RetryOptions<P> | undefined,
  defaults: P,
): P {
  const given = (options ?? {}) as Record<string, unknown>;
  const base = defaults as unknown as Record<string, unknown>;
  const policy: Record<string, unknown> = {};
  for (const key of Object.keys(base)) {
    const value = given[key] === undefined ? base[key] : given[key];
    const fallback = base[key];
    if (Array.isArray(fallback)) {
      policy[key] = checkList(key, value);
    } else if (typeof fallback === "boolean" && typeof value !== "boolean") {
      throw new RangeError(`retry.${key} must be a boolean, got ${value}`);
    } else {
      policy[key] = value;
    }
  }
  const maxRetries = policy.maxRetries;
  if (
    typeof maxRetries !== "number" || !Number.isInteger(maxRetries) ||
    maxRetries < 0
  ) {
    throw new RangeError(
      `retry.maxRetries must be a non-negative integer, got ${maxRetries}`,
    );
  }
  for (const [key, low, high] of NUMBERS) {
    checkNumber(key, policy[key], low, high);
  }
  if (policy.budgetMs !== null) {
    checkNumber("budgetMs", policy.budgetMs, 1, Number.POSITIVE_INFINITY);
  }
  if (typeof policy.respectRetryAfter !== "boolean") {
    throw new RangeError(
      `retry.respectRetryAfter must be a boolean, got ${policy.respectRetryAfter}`,
    );
  }
  return Object.freeze(policy) as unknown as P;
}

/**
 * The backoff before retry number `retry` (0 for the first retry):
 * `min(max, initial * 2^retry)`, less `jitter * random` of itself, rounded.
 */
export function backoffDelay(
  policy: RetryPolicy,
  retry: number,
  random: number,
): number {
  const base = Math.min(
    policy.backoffMaxMs,
    policy.backoffInitialMs * 2 ** Math.min(retry, 52),
  );
  return Math.max(0, Math.round(base * (1 - policy.backoffJitter * random)));
}

const DELTA_SECONDS = /^\s*(\d+(?:\.\d+)?)\s*$/;

/**
 * The server's requested wait in milliseconds, or null when it asks for none
 * that can be read. `retry-after-ms` (milliseconds, as the OpenAI-style SDKs
 * send and read) wins over `retry-after`, which is either delta-seconds or an
 * HTTP-date; a date in the past means no wait. An unreadable
 * `retry-after-ms` falls back to `retry-after`.
 */
export function parseRetryAfter(
  headers: Headers,
  nowMs: number,
): number | null {
  const milliseconds = headers.get("retry-after-ms");
  if (milliseconds !== null) {
    const match = DELTA_SECONDS.exec(milliseconds);
    if (match !== null) return Math.ceil(Number(match[1]));
  }
  const value = headers.get("retry-after");
  if (value === null) return null;
  const seconds = DELTA_SECONDS.exec(value);
  if (seconds !== null) return Math.ceil(Number(seconds[1]) * 1000);
  // An HTTP-date names its month and day; anything else that Date.parse
  // happens to accept (such as "-5", year -5) is not one.
  const date = /[A-Za-z]/.test(value) ? Date.parse(value) : Number.NaN;
  if (Number.isNaN(date)) return null;
  return Math.max(0, date - nowMs);
}

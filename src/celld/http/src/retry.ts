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
 * Whether a failed request may be sent again depends on the request as
 * much as the policy. {@link mayRetry} decides for an {@link HttpRetryPolicy}:
 * a request the server may already have acted on (it answered with a
 * status, timed out, or broke off mid-body) is repeated only when the caller
 * declared it idempotent, so a write is never duplicated by a retry. That
 * includes a connection failure: a rejected `fetch` does not prove the
 * server never saw the request.
 *
 * @module
 */

import { MAX_TIMER_MS, strictRecord } from "@celld/core/bounds";

/** The most retries a policy may ask for. */
export const MAX_RETRIES = 100;

/** The fields every retry policy has. */
export interface RetryPolicy {
  /** Retries after the first attempt, up to {@link MAX_RETRIES}; 0 disables retrying. */
  readonly maxRetries: number;
  /** The first backoff delay, doubled for each retry; at most `MAX_TIMER_MS`. */
  readonly backoffInitialMs: number;
  /** The largest backoff delay; at most `MAX_TIMER_MS`. */
  readonly backoffMaxMs: number;
  /**
   * The fraction of each backoff delay randomly subtracted, from 0 (none) to
   * 1 ("full jitter", a uniform delay between 0 and the backoff).
   */
  readonly backoffJitter: number;
  /** Whether to wait as `retry-after-ms` / `retry-after` ask, when present. */
  readonly respectRetryAfter: boolean;
  /**
   * The longest server-requested wait honoured, at most `MAX_TIMER_MS`;
   * longer ones are capped.
   */
  readonly maxRetryAfterMs: number;
  /**
   * Total time for one call, including every attempt, backoff and limiter
   * wait. A retry whose wait would reach it is not started; `null` disables.
   */
  readonly budgetMs: number | null;
}

/**
 * A policy that decides by HTTP status and by how an attempt failed. Use it
 * through {@link mayRetry}: `statuses` and `retryTimeouts` apply only to
 * requests declared idempotent.
 */
export interface HttpRetryPolicy extends RetryPolicy {
  /**
   * HTTP statuses retried for idempotent requests, sorted and without
   * duplicates once resolved.
   */
  readonly statuses: readonly number[];
  /** Whether to retry when the connection fails before any response. */
  readonly retryConnectionErrors: boolean;
  /**
   * Whether to retry an idempotent request that timed out on the client.
   */
  readonly retryTimeouts: boolean;
}

/**
 * How an attempt failed, for {@link mayRetry}:
 *
 * - `connection`: `fetch` rejected before any response began (DNS,
 *   refused, reset while connecting);
 * - `status`: a response arrived with `status`;
 * - `timeout`: the client gave up waiting, so the server may have the
 *   request;
 * - `body`: the response began but its body failed.
 *
 * Every kind may mean the server acted: `fetch` also rejects when the
 * connection breaks after the request was sent, before the answer began.
 */
export type RetryFailure =
  | { readonly kind: "connection" }
  | { readonly kind: "status"; readonly status: number }
  | { readonly kind: "timeout" }
  | { readonly kind: "body" };

/** What the caller declares about a request, for {@link mayRetry}. */
export interface RetryRequest {
  /**
   * Whether sending the request twice has the same effect as sending it
   * once: a read, a `PUT` of the same state, or a write carrying an
   * idempotency key the server deduplicates durably. There is no default.
   */
  readonly idempotent: boolean;
}

const IDEMPOTENT_METHODS = new Set([
  "GET",
  "HEAD",
  "OPTIONS",
  "TRACE",
  "PUT",
  "DELETE",
]);

/**
 * Whether RFC 9110 defines `method` as idempotent (GET, HEAD, OPTIONS,
 * TRACE, PUT, DELETE; case-insensitive). It says nothing about an API that
 * does writes over GET or reads over POST; declare those explicitly.
 */
export function isIdempotentMethod(method: string): boolean {
  return IDEMPOTENT_METHODS.has(method.toUpperCase());
}

/**
 * Whether `policy` allows another attempt after `failure` of `request`,
 * leaving the attempt count, backoff and budget to the caller.
 *
 * Any failure may mean the server acted: a status is an answer, a timeout
 * leaves the request with the server, a broken body came after the answer
 * began, and a rejected `fetch` can follow a request that was sent in full.
 * So nothing is retried unless `request.idempotent` is true, and then by
 * `retryConnectionErrors` (a lost connection or a broken body), `statuses`
 * or `retryTimeouts`. Nothing is retried when `maxRetries` is 0.
 *
 * @throws {TypeError} when `request.idempotent` is not a boolean: it must
 * be declared.
 */
export function mayRetry(
  policy: HttpRetryPolicy,
  failure: RetryFailure,
  request: RetryRequest,
): boolean {
  if (typeof request?.idempotent !== "boolean") {
    throw new TypeError(
      "mayRetry needs request.idempotent declared as true or false",
    );
  }
  if (policy.maxRetries === 0 || !request.idempotent) return false;
  switch (failure.kind) {
    case "connection":
      return policy.retryConnectionErrors;
    case "status":
      return policy.statuses.includes(failure.status);
    case "timeout":
      return policy.retryTimeouts;
    case "body":
      return policy.retryConnectionErrors;
  }
}

/**
 * A partial policy, as clients accept it: any subset of `P`'s fields, where
 * a list may be given as any iterable. `undefined` means "the default".
 */
export type RetryOptions<P extends RetryPolicy = HttpRetryPolicy> = {
  readonly [K in keyof P]?: P[K] extends readonly (infer T)[] ? Iterable<T>
    : P[K];
};

// Waits reach a timer, which fires at once past MAX_TIMER_MS.
const NUMBERS: readonly [keyof RetryPolicy, number, number][] = [
  ["backoffInitialMs", 0, MAX_TIMER_MS],
  ["backoffMaxMs", 0, MAX_TIMER_MS],
  ["backoffJitter", 0, 1],
  ["maxRetryAfterMs", 0, MAX_TIMER_MS],
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
  const unique = new Set<unknown>();
  let count = 0;
  for (const item of value as Iterable<unknown>) {
    if (++count > 1024) throw new RangeError(`retry.${key} has too many items`);
    unique.add(item);
  }
  const items = [...unique];
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
 * Only known data fields of `defaults` are accepted; unknown keys/accessors
 * are rejected with TypeError. An option that is `undefined`
 * takes the default. Numbers must be finite and in range (the waits at most
 * `MAX_TIMER_MS`, since a longer timer fires at once), `maxRetries` an
 * integer from 0 to {@link MAX_RETRIES}, `budgetMs` at least 1 or `null`,
 * and a field whose
 * default is a boolean must be a boolean. A field whose default is an array
 * accepts an iterable of at most 1024 items and loses duplicates; `statuses` must also hold HTTP
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
  strictRecord(defaults as unknown, Object.keys(base), "retry defaults");
  strictRecord(given, Object.keys(base), "retry options");
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
    maxRetries < 0 || maxRetries > MAX_RETRIES
  ) {
    throw new RangeError(
      `retry.maxRetries must be an integer from 0 to ${MAX_RETRIES}, got ${maxRetries}`,
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
 * `retry-after-ms` falls back to `retry-after`. The result is always a
 * safe integer: an absurd wait is cut to `Number.MAX_SAFE_INTEGER`, and the
 * caller caps it further (to `maxRetryAfterMs`).
 */
export function parseRetryAfter(
  headers: Headers,
  nowMs: number,
): number | null {
  const milliseconds = headers.get("retry-after-ms");
  if (milliseconds !== null) {
    const match = DELTA_SECONDS.exec(milliseconds);
    if (match !== null) return safeWait(Math.ceil(Number(match[1])));
  }
  const value = headers.get("retry-after");
  if (value === null) return null;
  const seconds = DELTA_SECONDS.exec(value);
  if (seconds !== null) return safeWait(Math.ceil(Number(seconds[1]) * 1000));
  // An HTTP-date names its month and day; anything else that Date.parse
  // happens to accept (such as "-5", year -5) is not one.
  const date = /[A-Za-z]/.test(value) ? Date.parse(value) : Number.NaN;
  if (Number.isNaN(date)) return null;
  return safeWait(Math.max(0, date - nowMs));
}

// A header of hundreds of digits reads as Infinity.
function safeWait(ms: number): number {
  return Math.min(ms, Number.MAX_SAFE_INTEGER);
}

// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * When and how long to wait before trying again: `@celld/http`'s retry
 * policy with jev's defaults.
 *
 * The defaults are the TypeSafe SDKs' (`RetryPolicy` in the JavaScript and
 * Python references): two retries after the first attempt, exponential
 * backoff from 500 ms doubling to at most 5 s with a quarter of each delay
 * randomly subtracted, `retry-after-ms` and `retry-after` honoured up to 60 s,
 * connection failures and timeouts retried, and a 30 s total budget per call
 * (the Python SDK's; the JavaScript one has none). One deliberate difference:
 * the SDKs also retry 408, and this policy never retries a 4xx other than
 * 429 unless `statuses` says so.
 *
 * @module
 */

import {
  type HttpRetryPolicy,
  resolveRetryPolicy as resolveHttpRetryPolicy,
  type RetryOptions as HttpRetryOptions,
} from "@celld/http";

export { backoffDelay, parseRetryAfter } from "@celld/http";

/**
 * A complete retry policy; `JevClient` takes any subset of it. This is
 * `@celld/http`'s `HttpRetryPolicy`: status codes, connection errors and
 * timeouts decide what is retried.
 */
export type RetryPolicy = HttpRetryPolicy;

/**
 * A partial policy, as `JevClient` accepts; `statuses` may be any iterable,
 * and a field set to `undefined` takes the default.
 */
export type RetryOptions = HttpRetryOptions<HttpRetryPolicy>;

const FIVE_HUNDREDS = Array.from({ length: 100 }, (_, index) => 500 + index);

/** The SDK defaults, less 408. */
export const DEFAULT_RETRY_POLICY: RetryPolicy = Object.freeze({
  maxRetries: 2,
  backoffInitialMs: 500,
  backoffMaxMs: 5_000,
  backoffJitter: 0.25,
  statuses: Object.freeze([429, ...FIVE_HUNDREDS]),
  respectRetryAfter: true,
  maxRetryAfterMs: 60_000,
  retryConnectionErrors: true,
  retryTimeouts: true,
  budgetMs: 30_000,
});

/**
 * Fills a partial policy from `base` (default {@link DEFAULT_RETRY_POLICY})
 * and checks it.
 *
 * @throws {RangeError} naming the first bad field.
 */
export function resolveRetryPolicy(
  options: RetryOptions = {},
  base: RetryPolicy = DEFAULT_RETRY_POLICY,
): RetryPolicy {
  return resolveHttpRetryPolicy(options, base);
}

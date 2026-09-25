// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * When and how long to wait before trying a command again.
 *
 * The exe.dev docs give no retry guidance beyond "429 means too many requests
 * from this SSH key", so the defaults are conventional: two retries after the
 * first attempt, exponential backoff from 500 ms doubling to 8 s with a
 * quarter of each delay randomly subtracted, `retry-after` honoured up to
 * 60 s, and a 120 s budget per call. Retries only ever apply to commands the
 * client knows are read-only (see `idempotent` in the command catalog); a
 * mutating command is sent once, whatever this policy says.
 *
 * The policy type, backoff and `retry-after` parsing are `@celld/http`'s;
 * this module holds exedev's defaults.
 *
 * @module
 */

import {
  type HttpRetryPolicy,
  resolveRetryPolicy as resolveHttpRetryPolicy,
  type RetryOptions as HttpRetryOptions,
} from "@celld/http";

export { backoffDelay, parseRetryAfter } from "@celld/http";

/** A complete retry policy; `ExeClient` takes any subset of it. */
export type RetryPolicy = HttpRetryPolicy;

/** A partial policy; `statuses` may be any iterable. */
export type RetryOptions = HttpRetryOptions<HttpRetryPolicy>;

/** The defaults described in the module notes. */
export const DEFAULT_RETRY_POLICY: RetryPolicy = Object.freeze({
  maxRetries: 2,
  backoffInitialMs: 500,
  backoffMaxMs: 8_000,
  backoffJitter: 0.25,
  statuses: Object.freeze([429, 500, 502, 503, 504]),
  respectRetryAfter: true,
  maxRetryAfterMs: 60_000,
  retryConnectionErrors: true,
  retryTimeouts: true,
  budgetMs: 120_000,
});

/**
 * Fills a partial policy from `base` (default {@link DEFAULT_RETRY_POLICY})
 * and checks it; see `@celld/http`'s `resolveRetryPolicy`.
 *
 * @throws {RangeError} naming the first bad field.
 */
export function resolveRetryPolicy(
  options: RetryOptions = {},
  base: RetryPolicy = DEFAULT_RETRY_POLICY,
): RetryPolicy {
  return resolveHttpRetryPolicy(options, base);
}

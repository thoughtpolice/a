// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * When and how long to wait before trying a model call again.
 *
 * A Responses call sent with `store: false` leaves nothing behind on the
 * server, so repeating one costs usage but has no other effect; what is
 * retried is decided by the failure's kind. The defaults follow Codex's
 * (`request_max_retries` of 4, exponential backoff, server `retry-after`
 * honoured) with a longer cap, because a subscription shared by several
 * agents is better served by waiting than by hammering. What is never
 * retried: usage limits (the wait is hours; the pacer handles it), quota,
 * policy refusals, context-window overflow, `response.incomplete`, bad
 * requests, auth failures, decode and output errors, and aborts.
 *
 * @module
 */

import {
  resolveRetryPolicy,
  type RetryOptions,
  type RetryPolicy,
} from "@celld/http";
import type { GptErrorKind } from "./errors.ts";

/**
 * `@celld/http`'s backoff, budget and `retry-after` handling, plus the
 * failure kinds to retry. The client takes any subset of it.
 */
export interface GptRetryPolicy extends RetryPolicy {
  /** The failure kinds retried. */
  readonly retryOn: readonly GptErrorKind[];
}

/** The transient kinds, retried by default. */
export const TRANSIENT_KINDS: readonly GptErrorKind[] = Object.freeze([
  "rate_limited",
  "overloaded",
  "server",
  "stream",
  "connection",
  "timeout",
]);

/**
 * The defaults. `budgetMs` is `null`, leaving only the per-attempt
 * timeouts, since a high-effort response can legitimately stream for many
 * minutes.
 */
export const DEFAULT_RETRY_POLICY: GptRetryPolicy = Object.freeze({
  maxRetries: 4,
  backoffInitialMs: 500,
  backoffMaxMs: 20_000,
  backoffJitter: 0.2,
  retryOn: TRANSIENT_KINDS,
  respectRetryAfter: true,
  maxRetryAfterMs: 120_000,
  budgetMs: null,
});

/** A partial policy, as the client accepts it; `retryOn` may be any iterable. */
export type GptRetryOptions = RetryOptions<GptRetryPolicy>;

/**
 * Fills a partial policy from `base` (default {@link DEFAULT_RETRY_POLICY})
 * and checks every field, as `@celld/http`'s `resolveRetryPolicy` does.
 *
 * @throws {RangeError} naming the first bad field.
 */
export function resolveGptRetryPolicy(
  options: GptRetryOptions = {},
  base: GptRetryPolicy = DEFAULT_RETRY_POLICY,
): GptRetryPolicy {
  return resolveRetryPolicy(options, base);
}

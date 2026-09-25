// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * TypeSafe's rate limits as `@celld/sec/ratelimit` policies, for the
 * client's `limiter`.
 *
 * TypeSafe limits each account by requests per minute and input tokens per
 * second, and says the numbers move while it adds capacity. So the limits
 * here are configuration, defaulting to the documented ones, and the
 * limiter is only a way to stay under them: the server's 429 stays
 * authoritative, and its `retry-after` holds the limiter's key, so every
 * caller sharing it pauses, not just the one that was refused.
 *
 * Token counts are not known until a response reports `usage.input_tokens`
 * (the docs give no tokenizer), so an attempt reserves `reserveTokens` (0
 * by default) and the difference is charged afterwards. The `tokens` policy
 * may go into debt; while it is, no new request is admitted until it is
 * paid off.
 *
 * @module
 */

import {
  type Policy,
  resolveLimits,
  resolvePolicies,
} from "@celld/sec/ratelimit";

/** Rate limits to stay under, in whole numbers. */
export interface RateLimits {
  /** Requests admitted per minute, on average. */
  readonly requestsPerMinute: number;
  /** Requests that may start at once after an idle spell. */
  readonly requestBurst: number;
  /** Input tokens charged per second, on average: at most a million. */
  readonly tokensPerSecond: number;
  /** Input tokens that may be charged at once after an idle spell. */
  readonly tokenBurst: number;
}

/**
 * Jev 1.13's documented limits, 1,200 requests per minute and 250,000 tokens
 * per second, with bursts of one second's worth of each.
 */
export const DEFAULT_RATE_LIMITS: RateLimits = Object.freeze({
  requestsPerMinute: 1200,
  requestBurst: 20,
  tokensPerSecond: 250_000,
  tokenBurst: 250_000,
});

/**
 * The policies for a limiter shared by the callers of one account:
 * `requests` and `tokens`, from `limits` over {@link DEFAULT_RATE_LIMITS}.
 *
 * ```ts
 * import { durableLimiter } from "@celld/sec/ratelimit";
 *
 * const client = JevClient.fromEnv(env, {
 *   limiter: durableLimiter(env.RATE_LIMITS, {
 *     name: "jev",
 *     policies: jevPolicies(),
 *   }),
 * });
 * ```
 *
 * @throws {TypeError} limits that are not an object, or a limit that is not
 * one of {@link RateLimits}.
 * @throws {RangeError} a limit that is not a whole number from 1, or more
 * than a million tokens a second.
 */
export function jevPolicies(limits: Partial<RateLimits> = {}): Policy[] {
  const resolved = resolveLimits(limits, DEFAULT_RATE_LIMITS);
  const policies = [
    {
      name: "requests",
      limit: resolved.requestsPerMinute,
      window: "PT1M",
      burst: resolved.requestBurst,
    },
    {
      name: "tokens",
      limit: resolved.tokensPerSecond,
      window: 1,
      burst: resolved.tokenBurst,
    },
  ];
  resolvePolicies(policies);
  return policies;
}

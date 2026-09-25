// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * exe.dev's rate limit as an `@celld/sec/ratelimit` policy, for the client's
 * `limiter`.
 *
 * exe.dev rate-limits per SSH key ("use separate SSH keys for independent
 * workloads") and does not publish the numbers. Every token signed by one
 * key shares that key's budget, so every Worker using tokens from one key
 * should share one limiter key: a `durableLimiter` over the `RateLimitShard`
 * Durable Objects, with the key's fingerprint as the client's `limiterKey`.
 *
 * The defaults (5 requests a second, burst 10) are a guess, not a
 * documented limit; the server's 429 stays the authority, and its
 * `retry-after` holds the limiter key so every caller sharing it pauses.
 *
 * @module
 */

import {
  durableLimiter,
  type Policy,
  type RateLimiter,
  resolveLimits,
  resolvePolicies,
  type ShardNamespace,
} from "@celld/sec/ratelimit";

/** Limits to stay under, in whole numbers. */
export interface RateLimits {
  /** Requests admitted per second, on average. */
  readonly requestsPerSecond: number;
  /** Requests that may start at once after an idle spell. */
  readonly burst: number;
}

/** A guess at a polite rate; see the module notes. */
export const DEFAULT_RATE_LIMITS: RateLimits = Object.freeze({
  requestsPerSecond: 5,
  burst: 10,
});

/**
 * The policy for a limiter shared by the clients of one SSH key:
 * `requests`, from `limits` over {@link DEFAULT_RATE_LIMITS}.
 *
 * ```ts
 * import { durableLimiter } from "@celld/sec/ratelimit";
 *
 * const client = ExeClient.fromEnv(env, {
 *   limiter: durableLimiter(env.RATE_LIMITS, {
 *     name: "exedev",
 *     policies: exePolicies(),
 *   }),
 *   limiterKey: "SHA256:...",
 * });
 * ```
 *
 * @throws {TypeError} limits that are not an object, or a limit that is not
 * one of {@link RateLimits}.
 * @throws {RangeError} a limit that is not a whole number from 1.
 */
export function exePolicies(limits: Partial<RateLimits> = {}): Policy[] {
  const resolved = resolveLimits(limits, DEFAULT_RATE_LIMITS);
  const policies = [{
    name: "requests",
    limit: resolved.requestsPerSecond,
    window: 1,
    burst: resolved.burst,
  }];
  resolvePolicies(policies);
  return policies;
}

/** The bindings {@link envLimiter} reads. */
export interface LimiterEnv {
  /** `@celld/sec/ratelimit`'s `RateLimitShard` objects; without, none. */
  readonly RATE_LIMITS?: ShardNamespace;
  /** Limits over {@link DEFAULT_RATE_LIMITS}, as JSON. A var. */
  readonly EXE_LIMITS?: string;
}

/**
 * The limiter a Worker's clients share, from its bindings: a
 * `durableLimiter` named `exedev` over `RATE_LIMITS`, with the limits in
 * `EXE_LIMITS` (such as `{"requestsPerSecond": 2}`), or none when
 * `RATE_LIMITS` is not bound. `ExeFleet` paces its client with it.
 *
 * @throws {TypeError} `EXE_LIMITS` that is not JSON, or not limits.
 * @throws {RangeError} a limit that is not a whole number from 1.
 */
export function envLimiter(env: LimiterEnv): RateLimiter | undefined {
  if (env.RATE_LIMITS === undefined) return undefined;
  let limits: Partial<RateLimits> = {};
  if (env.EXE_LIMITS !== undefined) {
    try {
      limits = JSON.parse(env.EXE_LIMITS);
    } catch (cause) {
      throw new TypeError("EXE_LIMITS must be JSON", { cause });
    }
  }
  return durableLimiter(env.RATE_LIMITS, {
    name: "exedev",
    policies: exePolicies(limits),
  });
}

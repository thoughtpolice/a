// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * Rate limits for celld: policies of `limit` units per `window` with a
 * `burst`, decided by the generic cell rate algorithm (GCRA), in memory or
 * in Durable Objects a fleet shares.
 *
 * ```ts
 * import { durableLimiter } from "@celld/sec/ratelimit";
 * export { RateLimitShard } from "@celld/sec/ratelimit/durable";
 *
 * const api = durableLimiter(env.RATE_LIMITS, {
 *   name: "api",
 *   policies: [
 *     { name: "burst", limit: 10, window: 1 },
 *     { name: "hourly", limit: 1000, window: "PT1H" },
 *   ],
 * });
 * const decision = await api.limit(`principal:${principal.key}`);
 * if (!decision.allowed) return tooMany(decision.retryAfterMs);
 * ```
 *
 * A client of an upstream API with its own limits waits for admission, and
 * settles and holds, through an {@link UpstreamLimit}. Router middleware is
 * in `@celld/sec/ratelimit/router`, the Durable Object in
 * `@celld/sec/ratelimit/durable`, and test doubles in
 * `@celld/sec/ratelimit/testing`.
 *
 * @module
 */

export {
  durableLimiter,
  type DurableLimiterOptions,
  RateLimitUnavailable,
  type ShardNamespace,
} from "./client.ts";
export {
  charge,
  type Decision,
  evaluate,
  type EvaluateOptions,
  type Evaluation,
  hold,
  type KeyState,
  type PolicyStatus,
  refund,
} from "./gcra.ts";
export { limitField, policyField, retryAfterField } from "./headers.ts";
export {
  importKeySecret,
  ipKey,
  type IpKeyOptions,
  shardOf,
  storageKey,
} from "./keys.ts";
export {
  type CostOptions,
  type HoldOptions,
  type LimitOptions,
  LocalLimiter,
  type LocalLimiterOptions,
  memoryLimiter,
  type RateLimiter,
} from "./limiter.ts";
export {
  type Cost,
  type Duration,
  durationMs,
  MAX_KEY_BYTES,
  MAX_POLICIES,
  MAX_UNITS,
  MAX_WINDOW_MS,
  MIN_INTERVAL_MS,
  type Policy,
  type ResolvedPolicy,
  resolveLimits,
  resolvePolicies,
  resolvePolicy,
} from "./policy.ts";
export {
  type Admission,
  type AdmitOptions,
  UpstreamLimit,
  type UpstreamLimitOptions,
} from "./upstream.ts";
export type {
  HoldRequest,
  RateLimitShardApi,
  ShardAnswer,
  ShardRequest,
  ShardStore,
} from "./shard.ts";

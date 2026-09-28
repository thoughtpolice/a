// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * {@link durableLimiter}: a {@link RateLimiter} shared by every Worker of a
 * fleet, over the `RateLimitShard` Durable Objects of
 * `@celld/sec/ratelimit/durable`.
 *
 * @module
 */

import type { Decision } from "./gcra.ts";
import { importKeySecret, shardOf, storageKey } from "./keys.ts";
import {
  checkHoldOptions,
  checkLimiterName,
  checkOptions,
  type CostOptions,
  type HoldOptions,
  type LimitOptions,
  type RateLimiter,
} from "./limiter.ts";
import {
  checkCost,
  checkDelay,
  checkKey,
  type Cost,
  type Policy,
  resolvePolicies,
} from "./policy.ts";
import type { HoldRequest, ShardAnswer, ShardRequest } from "./shard.ts";

/**
 * What {@link durableLimiter} needs of a namespace binding. A
 * `DurableObjectNamespace<RateLimitShardApi>` is one, and so is
 * `@celld/sec/ratelimit/testing`'s `memoryNamespace()`.
 */
export interface ShardNamespace {
  getByName(name: string): {
    limit(request: ShardRequest): Promise<ShardAnswer>;
    peek(request: ShardRequest): Promise<ShardAnswer>;
    refund(request: ShardRequest): Promise<void>;
    charge(request: ShardRequest): Promise<void>;
    hold(request: HoldRequest): Promise<void>;
    reset(request: { readonly key: string }): Promise<void>;
  };
}

/** Options for {@link durableLimiter}. */
export interface DurableLimiterOptions {
  /**
   * The limiter's name: 1 to 128 of `A-Z a-z 0-9 _ . : -`. It separates
   * this limiter's keys from every other limiter's on the same binding and
   * names its shards, so changing it starts every key afresh.
   */
  readonly name: string;
  readonly policies: readonly Policy[];
  /**
   * How many objects the keys are spread over, from 1 to 1024; default
   * 16. Each decision is one call to one of them, so more shards carry more
   * requests a second. Changing it moves keys between shards, which starts
   * them afresh.
   */
  readonly shards?: number;
  /**
   * A secret of at least 32 bytes that keys the stored hashes
   * (HMAC-SHA-256), so storage holds nothing a guess can be checked
   * against. Default none (SHA-256). Changing it starts every key afresh.
   */
  readonly secret?: string | Uint8Array;
  /**
   * Remember refusals in this isolate until the key could spend a unit
   * of every policy again, and refuse again without a call; default true.
   * Only requests that spend from every policy use it, and one that may
   * wait (`maxDelayMs`) only while it would have to wait longer. A `reset`
   * or `refund` elsewhere reaches this isolate's memory only when the
   * refusal runs out.
   */
  readonly denyCache?: boolean;
  /** Milliseconds since the epoch, for the refusal cache; default `Date.now`. */
  readonly now?: () => number;
}

/**
 * The limiter could not reach its shard, or the shard failed. What to do
 * then is the caller's choice: the router middleware refuses by default.
 */
export class RateLimitUnavailable extends Error {
  override readonly name = "RateLimitUnavailable";
}

interface Refusal {
  readonly decision: Decision;
  /** Each policy's share of the refused cost. */
  readonly cost: readonly number[];
  /** When it was made, and until when a unit stays out of reach. */
  readonly at: number;
  readonly until: number;
}

/** Refusals kept per isolate, per namespace binding. */
const MAX_REFUSALS = 4096;
const refusals = new WeakMap<object, Map<string, Refusal>>();

function remembered(namespace: object): Map<string, Refusal> {
  let map = refusals.get(namespace);
  if (map === undefined) {
    map = new Map();
    refusals.set(namespace, map);
  }
  return map;
}

function sameShares(a: readonly number[], b: readonly number[]): boolean {
  return a.length === b.length && a.every((share, i) => share === b[i]);
}

/** A remembered refusal, aged to `now`. */
function aged(
  refusal: Refusal,
  cost: readonly number[],
  now: number,
): Decision {
  const elapsed = now - refusal.at;
  const untilNext = Math.max(1, Math.ceil(refusal.until - now));
  return Object.freeze({
    allowed: false,
    delayMs: 0,
    retryAfterMs: sameShares(cost, refusal.cost)
      ? Math.max(untilNext, Math.ceil(refusal.decision.retryAfterMs - elapsed))
      : untilNext,
    remaining: refusal.decision.remaining,
    policies: Object.freeze(
      refusal.decision.policies.map((status) =>
        Object.freeze({
          ...status,
          resetMs: Math.max(0, Math.ceil(status.resetMs - elapsed)),
        })
      ),
    ),
  });
}

/**
 * A {@link RateLimiter} whose state lives in `RateLimitShard` objects, so
 * every Worker of a fleet shares it. Each key belongs to one shard, picked
 * by its hash; each decision is one RPC to that shard (none when the
 * refusal cache already knows the answer). A call that fails rejects with
 * {@link RateLimitUnavailable}.
 *
 * ```ts
 * const logins = durableLimiter(env.RATE_LIMITS, {
 *   name: "login-failures",
 *   policies: [{ name: "failures", limit: 5, window: "PT15M" }],
 * });
 * ```
 */
export function durableLimiter(
  namespace: ShardNamespace,
  options: DurableLimiterOptions,
): RateLimiter {
  if (typeof options !== "object" || options === null) {
    throw new TypeError("durableLimiter takes an options object");
  }
  for (const key of Object.keys(options)) {
    if (
      !["name", "policies", "shards", "secret", "denyCache", "now"].includes(
        key,
      )
    ) {
      throw new TypeError(
        `durableLimiter has no option ${JSON.stringify(key)}`,
      );
    }
  }
  if (
    typeof namespace !== "object" || namespace === null ||
    typeof namespace.getByName !== "function"
  ) {
    throw new TypeError(
      "durableLimiter takes the RateLimitShard namespace binding",
    );
  }
  const name = checkLimiterName(options.name);
  const policies = resolvePolicies(options.policies);
  const shards = options.shards ?? 16;
  if (!Number.isSafeInteger(shards) || shards < 1 || shards > 1024) {
    throw new RangeError("shards must be a whole number from 1 to 1024");
  }
  const secret = options.secret === undefined
    ? Promise.resolve(null)
    : importKeySecret(options.secret);
  // Settled now, so a bad secret is not an unhandled rejection before the
  // first call awaits it.
  secret.catch(() => {});
  const cache = options.denyCache === false ? null : remembered(namespace);
  const now = options.now ?? Date.now;

  async function locate(key: string) {
    const hash = await storageKey(name, key, await secret);
    const stub = namespace.getByName(
      `celld-ratelimit:${name}:${shardOf(hash, shards)}`,
    );
    return { hash, stub };
  }

  async function call<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (cause) {
      throw new RateLimitUnavailable(
        `rate limiter ${name} could not reach its shard`,
        { cause },
      );
    }
  }

  function request(hash: string, cost: Cost, maxDelayMs = 0): ShardRequest {
    return { key: hash, policies, cost, maxDelayMs };
  }

  return Object.freeze({
    name,
    policies,
    async limit(key: string, options?: LimitOptions): Promise<Decision> {
      checkKey(key);
      const checked = checkOptions(options, true);
      const cost = checked.cost ?? 1;
      const shares = checkCost(cost, policies);
      const maxDelayMs = checkDelay(checked.maxDelayMs ?? 0);
      const { hash, stub } = await locate(key);
      // A request that spends nothing from some policy may be admitted while
      // a unit of it is out of reach, so only the rest use the cache.
      const cached = cache !== null && shares.every((share) => share > 0);
      if (cached) {
        const refusal = cache.get(hash);
        const at = now();
        if (refusal === undefined || at >= refusal.until) {
          cache.delete(hash);
        } else if (maxDelayMs + 2 <= refusal.until - at) {
          // No such request is admitted before `until`, less up to 1 ms of
          // rounding, so one that may wait less than that is refused here;
          // one that may wait longer asks the shard, which may admit it
          // with a delay.
          return aged(refusal, shares, at);
        }
      }
      const answer = await call(() =>
        stub.limit(request(hash, cost, maxDelayMs))
      );
      if (cached && !answer.decision.allowed && answer.nextMs > 0) {
        const at = now();
        cache.set(hash, {
          decision: answer.decision,
          cost: shares,
          at,
          until: at + answer.nextMs,
        });
        while (cache.size > MAX_REFUSALS) {
          cache.delete(cache.keys().next().value!);
        }
      }
      return answer.decision;
    },
    async peek(key: string, options?: CostOptions): Promise<Decision> {
      checkKey(key);
      const cost = checkOptions(options, false).cost ?? 1;
      checkCost(cost, policies);
      const { hash, stub } = await locate(key);
      return (await call(() => stub.peek(request(hash, cost)))).decision;
    },
    async refund(key: string, options?: CostOptions): Promise<void> {
      checkKey(key);
      const cost = checkOptions(options, false).cost ?? 1;
      checkCost(cost, policies);
      const { hash, stub } = await locate(key);
      cache?.delete(hash);
      await call(() => stub.refund(request(hash, cost)));
    },
    async charge(key: string, options?: CostOptions): Promise<void> {
      checkKey(key);
      const cost = checkOptions(options, false).cost ?? 1;
      checkCost(cost, policies, true);
      const { hash, stub } = await locate(key);
      await call(() => stub.charge(request(hash, cost)));
    },
    async hold(key: string, options: HoldOptions): Promise<void> {
      checkKey(key);
      const forMs = checkHoldOptions(options);
      const { hash, stub } = await locate(key);
      await call(() => stub.hold({ key: hash, forMs }));
    },
    async reset(key: string): Promise<void> {
      checkKey(key);
      const { hash, stub } = await locate(key);
      cache?.delete(hash);
      await call(() => stub.reset({ key: hash }));
    },
  });
}

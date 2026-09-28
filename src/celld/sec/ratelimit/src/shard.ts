// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * What a rate limit shard does, apart from where it keeps its state: the
 * `RateLimitShard` Durable Object in `@celld/sec/ratelimit/durable` runs a
 * {@link ShardCore} over its SQLite, and `@celld/sec/ratelimit/testing` runs
 * one over a map.
 *
 * @module
 */

import {
  charge,
  type Decision,
  evaluate,
  hold,
  type KeyState,
  refund,
} from "./gcra.ts";
import {
  checkCost,
  checkDelay,
  checkHold,
  type Cost,
  type ResolvedPolicy,
  resolvePolicies,
} from "./policy.ts";

/** A request to a shard, as `durableLimiter` sends it. */
export interface ShardRequest {
  /** A storage key: 64 lower-case hex digits. */
  readonly key: string;
  readonly policies: readonly ResolvedPolicy[];
  readonly cost: Cost;
  readonly maxDelayMs: number;
}

/** A request to hold a key, as `durableLimiter` sends it. */
export interface HoldRequest {
  /** A storage key: 64 lower-case hex digits. */
  readonly key: string;
  readonly forMs: number;
}

/** A shard's answer. */
export interface ShardAnswer {
  readonly decision: Decision;
  /** Milliseconds until one unit would be admitted; see `Evaluation`. */
  readonly nextMs: number;
}

/**
 * The RPC surface of the `RateLimitShard` Durable Object. Type its
 * namespace binding with it:
 * `RATE_LIMITS: DurableObjectNamespace<RateLimitShardApi>`.
 */
export interface RateLimitShardApi {
  limit(request: ShardRequest): ShardAnswer;
  peek(request: ShardRequest): ShardAnswer;
  refund(request: ShardRequest): void;
  charge(request: ShardRequest): void;
  hold(request: HoldRequest): void;
  reset(request: { readonly key: string }): void;
}

/**
 * Where a shard keeps each key's state, one per policy name, and its hold
 * under the name {@link HOLD}. Everything is synchronous, so a shard's
 * decision is atomic.
 */
export interface ShardStore {
  /** The states of `key` for these policies (null for none). */
  read(key: string, policies: readonly string[]): (KeyState | null)[];
  /** Stores the states of `key`, atomically; a null one is deleted. */
  write(
    key: string,
    policies: readonly string[],
    states: readonly (KeyState | null)[],
  ): void;
  /** Deletes every state of `key`. */
  clear(key: string): void;
  /** Deletes up to `max` states idle by `now` (TAT at or before it). */
  sweep(now: number, max: number): void;
}

/** A {@link ShardStore} in a map, for tests. */
export class MemoryShardStore implements ShardStore {
  readonly #states = new Map<string, KeyState>();

  #id(key: string, policy: string): string {
    return `${key}\u0000${policy}`;
  }

  read(key: string, policies: readonly string[]): (KeyState | null)[] {
    return policies.map((policy) =>
      this.#states.get(this.#id(key, policy)) ?? null
    );
  }

  write(
    key: string,
    policies: readonly string[],
    states: readonly (KeyState | null)[],
  ): void {
    policies.forEach((policy, i) => {
      const state = states[i];
      if (state === null) this.#states.delete(this.#id(key, policy));
      else this.#states.set(this.#id(key, policy), state);
    });
  }

  clear(key: string): void {
    for (const id of [...this.#states.keys()]) {
      if (id.startsWith(`${key}\u0000`)) this.#states.delete(id);
    }
  }

  sweep(now: number, max: number): void {
    let left = max;
    for (const [id, state] of [...this.#states]) {
      if (left === 0) break;
      if (state.at + state.ahead <= now) {
        this.#states.delete(id);
        left--;
      }
    }
  }

  /** How many states it holds. */
  get size(): number {
    return this.#states.size;
  }
}

const STORAGE_KEY = /^[0-9a-f]{64}$/;

/**
 * The name a key's hold is stored under, beside its policies: no policy
 * can have it, since policy names have no colon. The hold is a
 * {@link KeyState} whose TAT is its end, so the sweep drops it once it
 * has passed.
 */
export const HOLD = ":hold";

function checkStorageKey(key: unknown): string {
  if (typeof key !== "string" || !STORAGE_KEY.test(key)) {
    throw new TypeError("a shard request's key must be 64 hex digits");
  }
  return key;
}

/** Idle rows each call deletes, so storage tracks the busy keys. */
const SWEEP = 8;

function checkRequest(request: ShardRequest, overdraw = false): {
  key: string;
  policies: readonly ResolvedPolicy[];
  names: string[];
  cost: number[];
  maxDelayMs: number;
} {
  if (typeof request !== "object" || request === null) {
    throw new TypeError("a shard request must be an object");
  }
  const key = checkStorageKey(request.key);
  const policies = resolvePolicies(request.policies);
  return {
    key,
    policies,
    names: policies.map((policy) => policy.name),
    cost: checkCost(request.cost, policies, overdraw),
    maxDelayMs: checkDelay(request.maxDelayMs),
  };
}

/**
 * A shard's behaviour over a {@link ShardStore}. It checks every request
 * again (the policies included), decides with the shard's own clock, and
 * deletes a few idle rows on each write.
 */
export class ShardCore implements RateLimitShardApi {
  readonly #store: ShardStore;
  readonly #now: () => number;

  constructor(store: ShardStore, now: () => number = Date.now) {
    this.#store = store;
    this.#now = now;
  }

  #decide(request: ShardRequest, commit: boolean): ShardAnswer {
    const { key, policies, names, cost, maxDelayMs } = checkRequest(request);
    const now = this.#now();
    const states = this.#store.read(key, [...names, HOLD]);
    const held = states.pop() ?? null;
    const result = evaluate(policies, states, now, cost, {
      maxDelayMs,
      commit,
      hold: held,
    });
    if (commit && result.changed) {
      this.#store.write(key, names, result.states);
      this.#store.sweep(now, SWEEP);
    }
    return { decision: result.decision, nextMs: result.nextMs };
  }

  limit(request: ShardRequest): ShardAnswer {
    return this.#decide(request, true);
  }

  peek(request: ShardRequest): ShardAnswer {
    return this.#decide(request, false);
  }

  /** Writes the states that differ from those read, and only those. */
  #writeChanged(
    key: string,
    names: readonly string[],
    before: readonly (KeyState | null)[],
    after: readonly (KeyState | null)[],
  ): void {
    const changed = names.flatMap((_, i) => after[i] === before[i] ? [] : [i]);
    if (changed.length === 0) return;
    this.#store.write(
      key,
      changed.map((i) => names[i]),
      changed.map((i) => after[i]),
    );
  }

  refund(request: ShardRequest): void {
    const { key, policies, names, cost } = checkRequest(request);
    const now = this.#now();
    const before = this.#store.read(key, names);
    this.#writeChanged(
      key,
      names,
      before,
      refund(policies, before, now, cost),
    );
  }

  charge(request: ShardRequest): void {
    const { key, policies, names, cost } = checkRequest(request, true);
    const now = this.#now();
    const before = this.#store.read(key, names);
    this.#writeChanged(
      key,
      names,
      before,
      charge(policies, before, now, cost),
    );
    this.#store.sweep(now, SWEEP);
  }

  hold(request: HoldRequest): void {
    if (typeof request !== "object" || request === null) {
      throw new TypeError("a shard request must be an object");
    }
    const key = checkStorageKey(request.key);
    const forMs = checkHold(request.forMs);
    const now = this.#now();
    const [held] = this.#store.read(key, [HOLD]);
    this.#store.write(key, [HOLD], [hold(held, now, forMs)]);
    this.#store.sweep(now, SWEEP);
  }

  reset(request: { readonly key: string }): void {
    if (typeof request !== "object" || request === null) {
      throw new TypeError("a shard request must be an object");
    }
    this.#store.clear(checkStorageKey(request.key));
  }
}

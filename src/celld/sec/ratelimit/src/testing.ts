// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * Test doubles: {@link memoryNamespace}, a stand-in for the
 * `RateLimitShard` namespace binding that runs the real shard logic over
 * maps, so an application tests its `durableLimiter` wiring without a
 * runtime, and {@link ManualClock}. `ShardCore` and `MemoryShardStore`
 * are the pieces it is made of, and `HOLD` names a held key's stored row.
 *
 * @module
 */

import type { ShardNamespace } from "./client.ts";
import type { Cost } from "./policy.ts";
import {
  HOLD,
  type HoldRequest,
  MemoryShardStore,
  type ShardAnswer,
  ShardCore,
  type ShardRequest,
} from "./shard.ts";

export { HOLD, MemoryShardStore, ShardCore };

/** A clock a test moves by hand. */
export class ManualClock {
  #now: number;

  constructor(start = Date.UTC(2026, 0, 1)) {
    this.#now = start;
  }

  /** The time, in epoch milliseconds; pass as `now: clock.now`. */
  readonly now = (): number => this.#now;

  /** Moves the clock forward. */
  advance(ms: number): void {
    if (!Number.isFinite(ms) || ms < 0) {
      throw new RangeError("a clock only moves forward");
    }
    this.#now += ms;
  }
}

/** One call a {@link MemoryNamespace} received. */
export interface ShardCall {
  readonly shard: string;
  readonly method: "limit" | "peek" | "refund" | "charge" | "hold" | "reset";
  readonly key: string;
  readonly cost?: Cost;
  readonly forMs?: number;
}

/** {@link memoryNamespace}'s result. */
export interface MemoryNamespace extends ShardNamespace {
  /** Every call, in order. */
  readonly calls: ShardCall[];
  /** The shards created so far, by name. */
  readonly shards: ReadonlyMap<string, MemoryShardStore>;
  /**
   * Makes every call reject with this error (as an unreachable object
   * would) until set back to null.
   */
  failWith: Error | null;
}

/**
 * A namespace whose shards are {@link ShardCore}s over
 * {@link MemoryShardStore}s, answering asynchronously as a stub would and
 * copying requests and answers through `structuredClone`, as RPC does.
 */
export function memoryNamespace(
  options: { readonly now?: () => number } = {},
): MemoryNamespace {
  const now = options.now ?? Date.now;
  const stores = new Map<string, MemoryShardStore>();
  const cores = new Map<string, ShardCore>();
  const namespace: MemoryNamespace = {
    calls: [],
    shards: stores,
    failWith: null,
    getByName(name: string) {
      const core = () => {
        let found = cores.get(name);
        if (found === undefined) {
          const store = new MemoryShardStore();
          stores.set(name, store);
          found = new ShardCore(store, now);
          cores.set(name, found);
        }
        return found;
      };
      const invoke = <T>(
        method: ShardCall["method"],
        request: ShardRequest | HoldRequest | { readonly key: string },
        fn: (core: ShardCore, request: never) => T,
      ): Promise<T> => {
        const copied = structuredClone(request);
        namespace.calls.push({
          shard: name,
          method,
          key: copied.key,
          ...("cost" in copied ? { cost: copied.cost } : {}),
          ...("forMs" in copied ? { forMs: copied.forMs } : {}),
        });
        if (namespace.failWith !== null) {
          return Promise.reject(namespace.failWith);
        }
        try {
          return Promise.resolve(
            structuredClone(fn(core(), copied as never)),
          );
        } catch (error) {
          return Promise.reject(error);
        }
      };
      return {
        limit: (request: ShardRequest): Promise<ShardAnswer> =>
          invoke("limit", request, (c, r: ShardRequest) => c.limit(r)),
        peek: (request: ShardRequest): Promise<ShardAnswer> =>
          invoke("peek", request, (c, r: ShardRequest) => c.peek(r)),
        refund: (request: ShardRequest): Promise<void> =>
          invoke("refund", request, (c, r: ShardRequest) => c.refund(r)),
        charge: (request: ShardRequest): Promise<void> =>
          invoke("charge", request, (c, r: ShardRequest) => c.charge(r)),
        hold: (request: HoldRequest): Promise<void> =>
          invoke("hold", request, (c, r: HoldRequest) => c.hold(r)),
        reset: (request: { readonly key: string }): Promise<void> =>
          invoke("reset", request, (c, r: { key: string }) => c.reset(r)),
      };
    },
  };
  return namespace;
}

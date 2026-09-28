// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * `RateLimitShard`, the Durable Object behind `durableLimiter`, and the
 * only module here that imports `cloudflare:workers`.
 *
 * A limiter spreads its keys over a fixed number of shards, each one
 * object. Its methods are synchronous, so each decision is atomic: no two
 * callers can spend the same unit. The state (two numbers per key and
 * policy, and per held key) is written to the object's SQLite on every admitted request,
 * inside `transactionSync`, so an evicted or restarted object forgets
 * nothing. It does not wait for `storage.sync()`: a node lost before its
 * writes reach the fleet's storage forgets its last few decisions, which
 * admits at most those requests again, and waiting would put a storage
 * round trip on every request.
 *
 * Export it from the Worker and bind it:
 *
 * ```ts
 * export { RateLimitShard } from "@celld/sec/ratelimit/durable";
 * ```
 *
 * ```python
 * celld.project(..., bindings = {"RATE_LIMITS": "RateLimitShard"})
 * ```
 *
 * @module
 */

import { DurableObject } from "cloudflare:workers";
import type { KeyState } from "./gcra.ts";
import {
  type HoldRequest,
  type RateLimitShardApi,
  type ShardAnswer,
  ShardCore,
  type ShardRequest,
  type ShardStore,
} from "./shard.ts";

export type { HoldRequest, RateLimitShardApi, ShardAnswer, ShardRequest };

/** A {@link ShardStore} in a Durable Object's SQLite. */
class SqlShardStore implements ShardStore {
  readonly #storage: DurableObjectStorage;

  constructor(storage: DurableObjectStorage) {
    this.#storage = storage;
    const sql = storage.sql;
    sql.exec(
      // `until` (the TAT, rounded) only orders the sweep of idle rows.
      "CREATE TABLE IF NOT EXISTS celld_ratelimit (key TEXT NOT NULL, policy TEXT NOT NULL, at REAL NOT NULL, ahead REAL NOT NULL, until REAL NOT NULL, PRIMARY KEY (key, policy))",
    ).toArray();
    sql.exec(
      "CREATE INDEX IF NOT EXISTS celld_ratelimit_until ON celld_ratelimit (until)",
    ).toArray();
  }

  read(key: string, policies: readonly string[]): (KeyState | null)[] {
    const rows = this.#storage.sql.exec<
      { policy: string; at: number; ahead: number }
    >(
      "SELECT policy, at, ahead FROM celld_ratelimit WHERE key = ?",
      key,
    ).toArray();
    const found = new Map(
      rows.map((row) => [row.policy, { at: row.at, ahead: row.ahead }]),
    );
    return policies.map((policy) => found.get(policy) ?? null);
  }

  write(
    key: string,
    policies: readonly string[],
    states: readonly (KeyState | null)[],
  ): void {
    this.#storage.transactionSync(() => {
      policies.forEach((policy, i) => {
        const state = states[i];
        if (state === null) {
          this.#storage.sql.exec(
            "DELETE FROM celld_ratelimit WHERE key = ? AND policy = ?",
            key,
            policy,
          ).toArray();
        } else {
          this.#storage.sql.exec(
            "INSERT INTO celld_ratelimit (key, policy, at, ahead, until) VALUES (?, ?, ?, ?, ?) ON CONFLICT (key, policy) DO UPDATE SET at = excluded.at, ahead = excluded.ahead, until = excluded.until",
            key,
            policy,
            state.at,
            state.ahead,
            state.at + state.ahead,
          ).toArray();
        }
      });
    });
  }

  clear(key: string): void {
    this.#storage.sql.exec("DELETE FROM celld_ratelimit WHERE key = ?", key)
      .toArray();
  }

  sweep(now: number, max: number): void {
    this.#storage.sql.exec(
      "DELETE FROM celld_ratelimit WHERE rowid IN (SELECT rowid FROM celld_ratelimit WHERE until <= ? LIMIT ?)",
      now,
      max,
    ).toArray();
  }
}

/** One shard of the keys of every `durableLimiter` bound to its namespace. */
export class RateLimitShard extends DurableObject implements RateLimitShardApi {
  readonly #core: ShardCore;

  constructor(ctx: DurableObjectState, env: unknown) {
    super(ctx, env);
    this.#core = new ShardCore(new SqlShardStore(ctx.storage));
  }

  limit(request: ShardRequest): ShardAnswer {
    return this.#core.limit(request);
  }

  peek(request: ShardRequest): ShardAnswer {
    return this.#core.peek(request);
  }

  refund(request: ShardRequest): void {
    this.#core.refund(request);
  }

  charge(request: ShardRequest): void {
    this.#core.charge(request);
  }

  hold(request: HoldRequest): void {
    this.#core.hold(request);
  }

  reset(request: { readonly key: string }): void {
    this.#core.reset(request);
  }
}

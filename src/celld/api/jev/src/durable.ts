// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * `JevRateLimiter`, the fleet-wide rate limiter Durable Object.
 *
 * One named instance is the single admission point for every Worker using a
 * given API key. Its methods are synchronous, so each decision is atomic: no
 * two callers can take the same slot.
 *
 * The bucket levels live in memory. They are soft state, refilled at a known
 * rate, so writing them on every request would buy nothing but storage
 * traffic: if the object is evicted or moves node, it restarts with full
 * buckets, which admits at most one burst early, and the server's 429 (fed
 * back through `throttle`) still bounds the damage. The configured limits are
 * different, since an operator set them, so `configure` stores them in the
 * object's SQLite with one synchronous statement, waits for `storage.sync()`
 * before acknowledging, and the constructor reads them back.
 *
 * Export it from the Worker and bind it:
 *
 * ```ts
 * export { JevRateLimiter } from "@celld/api/jev/durable";
 * ```
 *
 * ```python
 * celld.project(..., bindings = {"JEV_LIMITER": "JevRateLimiter"})
 * ```
 *
 * @module
 */

import { DurableObject } from "cloudflare:workers";
import {
  type BucketSnapshot,
  type RateLimiterApi,
  type RateLimits,
  resolveRateLimits,
  TokenBucket,
} from "./limiter.ts";
import type { LimiterDecision } from "./types.ts";

export type { RateLimiterApi, RateLimits };

/** The Durable Object behind `durableLimiter`. */
export class JevRateLimiter extends DurableObject implements RateLimiterApi {
  #bucket: TokenBucket;

  constructor(ctx: DurableObjectState, env: unknown) {
    super(ctx, env);
    const sql = ctx.storage.sql;
    sql.exec(
      "CREATE TABLE IF NOT EXISTS jev_limits (id INTEGER PRIMARY KEY CHECK (id = 1), limits TEXT NOT NULL)",
    ).toArray();
    const rows = sql.exec<{ limits: string }>(
      "SELECT limits FROM jev_limits WHERE id = 1",
    ).toArray();
    let limits = resolveRateLimits();
    if (rows.length === 1) {
      try {
        limits = resolveRateLimits(JSON.parse(rows[0].limits));
      } catch {
        // Unreadable limits fall back to the documented defaults.
      }
    }
    this.#bucket = new TokenBucket(limits, Date.now());
  }

  acquire(request: { readonly reserveTokens: number }): LimiterDecision {
    return this.#bucket.acquire(Date.now(), request.reserveTokens);
  }

  settle(
    charge: { readonly reservedTokens: number; readonly actualTokens: number },
  ): void {
    this.#bucket.settle(Date.now(), charge.reservedTokens, charge.actualTokens);
  }

  throttle(request: { readonly retryAfterMs: number }): void {
    this.#bucket.throttle(Date.now(), request.retryAfterMs);
  }

  async configure(limits: Partial<RateLimits>): Promise<RateLimits> {
    const current = this.#bucket.snapshot(Date.now()).limits;
    const next = resolveRateLimits(limits, current);
    this.ctx.storage.sql.exec(
      "INSERT INTO jev_limits (id, limits) VALUES (1, ?) ON CONFLICT (id) DO UPDATE SET limits = excluded.limits",
      JSON.stringify(next),
    ).toArray();
    this.#bucket.configure(Date.now(), next);
    await this.ctx.storage.sync();
    return next;
  }

  snapshot(): BucketSnapshot {
    return this.#bucket.snapshot(Date.now());
  }
}

// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * Client-side rate limiting: a two-dimensional token bucket (requests and
 * input tokens), an in-isolate {@link Limiter} built on it, and the adapter
 * that makes the fleet-wide Durable Object in `@celld/api/jev/durable` one.
 *
 * TypeSafe limits each account by requests per minute and input tokens per
 * second, and says the numbers move while it adds capacity. So the limits
 * here are configuration, defaulting to the documented ones, and the bucket
 * is only a way to stay under them: the server's 429 stays authoritative, and
 * its `retry-after` is fed back through {@link Limiter.throttle} so that every
 * caller sharing the limiter pauses, not just the one that was refused.
 *
 * Token counts are not known until a response reports `usage.input_tokens`
 * (the docs give no tokenizer), so admission reserves `reserveTokens` (0 by
 * default) and the actual count is charged afterwards. The token bucket may
 * go into debt; while it is, no new request is admitted until it refills.
 *
 * @module
 */

import type { Limiter, LimiterDecision } from "./types.ts";

/** Rate limits to stay under. */
export interface RateLimits {
  /** Requests admitted per minute, on average. */
  readonly requestsPerMinute: number;
  /** Requests that may start at once after an idle spell. */
  readonly requestBurst: number;
  /** Input tokens charged per second, on average. */
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
 * Fills a partial set of limits from `base` and checks them.
 *
 * @throws {RangeError} a limit that is not a positive finite number, or a
 * request burst below one.
 */
export function resolveRateLimits(
  limits: Partial<RateLimits> = {},
  base: RateLimits = DEFAULT_RATE_LIMITS,
): RateLimits {
  const merged = { ...base, ...limits };
  for (const name of Object.keys(DEFAULT_RATE_LIMITS) as (keyof RateLimits)[]) {
    const value = merged[name];
    if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
      throw new RangeError(`${name} must be a positive number, got ${value}`);
    }
  }
  if (merged.requestBurst < 1) {
    throw new RangeError(
      `requestBurst must be at least 1, got ${merged.requestBurst}`,
    );
  }
  return Object.freeze({
    requestsPerMinute: merged.requestsPerMinute,
    requestBurst: merged.requestBurst,
    tokensPerSecond: merged.tokensPerSecond,
    tokenBurst: merged.tokenBurst,
  });
}

/** A bucket's state, for dashboards and tests. */
export interface BucketSnapshot {
  readonly limits: RateLimits;
  /** Requests that could start now. */
  readonly requests: number;
  /** Input tokens available now; negative while in debt. */
  readonly tokens: number;
  /** Until when a server `retry-after` holds every request, in epoch ms. */
  readonly blockedUntil: number;
}

function amount(name: string, value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new RangeError(`${name} must be a non-negative number, got ${value}`);
  }
  return value;
}

/**
 * The bucket arithmetic, with time passed in: no clock, no I/O, so it is
 * deterministic under test and atomic inside a Durable Object method.
 */
export class TokenBucket {
  #limits: RateLimits;
  #requests: number;
  #tokens: number;
  #updated: number;
  #blockedUntil = 0;

  constructor(limits: RateLimits, now: number) {
    this.#limits = resolveRateLimits(limits);
    this.#requests = this.#limits.requestBurst;
    this.#tokens = this.#limits.tokenBurst;
    this.#updated = now;
  }

  #refill(now: number): void {
    const seconds = Math.max(0, now - this.#updated) / 1000;
    this.#updated = Math.max(this.#updated, now);
    const limits = this.#limits;
    this.#requests = Math.min(
      limits.requestBurst,
      this.#requests + seconds * limits.requestsPerMinute / 60,
    );
    this.#tokens = Math.min(
      limits.tokenBurst,
      this.#tokens + seconds * limits.tokensPerSecond,
    );
  }

  /**
   * Admits one request, reserving `reserveTokens` (capped at the token
   * burst), or says how long until it could.
   */
  acquire(now: number, reserveTokens: number): LimiterDecision {
    const reserve = Math.min(
      amount("reserveTokens", reserveTokens),
      this.#limits.tokenBurst,
    );
    this.#refill(now);
    const limits = this.#limits;
    let wait = Math.max(0, this.#blockedUntil - now);
    if (this.#requests < 1) {
      wait = Math.max(
        wait,
        (1 - this.#requests) / (limits.requestsPerMinute / 60) * 1000,
      );
    }
    const needed = Math.max(reserve, 0);
    if (this.#tokens < needed) {
      wait = Math.max(
        wait,
        (needed - this.#tokens) / limits.tokensPerSecond * 1000,
      );
    }
    if (wait > 0) {
      return { granted: false, waitMs: Math.max(1, Math.ceil(wait)) };
    }
    this.#requests -= 1;
    this.#tokens -= reserve;
    return { granted: true };
  }

  /** Charges the difference between the tokens used and those reserved. */
  settle(now: number, reservedTokens: number, actualTokens: number): void {
    const reserved = Math.min(
      amount("reservedTokens", reservedTokens),
      this.#limits.tokenBurst,
    );
    const actual = amount("actualTokens", actualTokens);
    this.#refill(now);
    this.#tokens -= actual - reserved;
  }

  /** Holds every request until `retryAfterMs` from now. */
  throttle(now: number, retryAfterMs: number): void {
    this.#blockedUntil = Math.max(
      this.#blockedUntil,
      now + amount("retryAfterMs", retryAfterMs),
    );
  }

  /** Replaces the limits, keeping the current levels within the new bursts. */
  configure(now: number, limits: RateLimits): void {
    this.#refill(now);
    this.#limits = resolveRateLimits(limits);
    this.#requests = Math.min(this.#requests, this.#limits.requestBurst);
    this.#tokens = Math.min(this.#tokens, this.#limits.tokenBurst);
  }

  /** The state as of `now`. */
  snapshot(now: number): BucketSnapshot {
    this.#refill(now);
    return {
      limits: this.#limits,
      requests: this.#requests,
      tokens: this.#tokens,
      blockedUntil: this.#blockedUntil,
    };
  }
}

/** Options for {@link memoryLimiter}. */
export interface MemoryLimiterOptions {
  /** Limits over the defaults. */
  readonly limits?: Partial<RateLimits>;
  /** The clock; defaults to `Date.now`. */
  readonly now?: () => number;
}

/**
 * A limiter in this isolate's memory. It limits only the requests made
 * through it, so use it for one process or for tests; a fleet shares the
 * Durable Object limiter instead.
 */
export function memoryLimiter(
  options: MemoryLimiterOptions = {},
): Limiter & { snapshot(): BucketSnapshot } {
  const now = options.now ?? Date.now;
  const bucket = new TokenBucket(resolveRateLimits(options.limits), now());
  return {
    acquire: ({ reserveTokens }) => bucket.acquire(now(), reserveTokens),
    settle: ({ reservedTokens, actualTokens }) =>
      bucket.settle(now(), reservedTokens, actualTokens),
    throttle: ({ retryAfterMs }) => bucket.throttle(now(), retryAfterMs),
    snapshot: () => bucket.snapshot(now()),
  };
}

/**
 * The RPC surface of the `JevRateLimiter` Durable Object in
 * `@celld/api/jev/durable`. Type its namespace binding with it:
 * `JEV_LIMITER: DurableObjectNamespace<RateLimiterApi>`.
 */
export interface RateLimiterApi {
  acquire(request: { readonly reserveTokens: number }): LimiterDecision;
  settle(
    charge: { readonly reservedTokens: number; readonly actualTokens: number },
  ): void;
  throttle(request: { readonly retryAfterMs: number }): void;
  /** Replaces some limits and stores them durably; returns the result. */
  configure(limits: Partial<RateLimits>): Promise<RateLimits>;
  /** The current limits and levels. */
  snapshot(): BucketSnapshot;
}

/**
 * A {@link Limiter} backed by the `JevRateLimiter` Durable Object named
 * `name` (one per API key or account; default `"default"`), shared by every
 * Worker in the fleet. A stub is taken for each call, so the limiter may be
 * built once and kept.
 *
 * ```ts
 * const client = JevClient.fromEnv(env, {
 *   limiter: durableLimiter(env.JEV_LIMITER),
 * });
 * ```
 */
export function durableLimiter(
  namespace: DurableObjectNamespace<RateLimiterApi>,
  name = "default",
): Limiter {
  const stub = () => namespace.getByName(name);
  return {
    acquire: (request) => stub().acquire(request),
    settle: (charge) => stub().settle(charge),
    throttle: (request) => stub().throttle(request),
  };
}

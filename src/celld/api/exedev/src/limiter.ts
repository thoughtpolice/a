// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * Client-side pacing for the HTTPS API.
 *
 * exe.dev rate-limits per SSH key ("use separate SSH keys for independent
 * workloads") and does not publish the numbers. Every token signed by one
 * key shares that key's budget, so every Worker using tokens from one key
 * should share one limiter: the `ExeKeyLimiter` Durable Object in
 * `@celld/api/exedev/durable`, one instance per key (name it by the key's
 * fingerprint), adapted here by {@link durableLimiter}.
 *
 * It is a token bucket in requests per second. The defaults (5 per second,
 * burst 10) are a guess, not a documented limit; the server's 429 stays the
 * authority, and its `retry-after` is fed back through `throttle` so every
 * caller sharing the limiter pauses.
 *
 * @module
 */

/** What a limiter says about one request. */
export type LimiterDecision =
  | { readonly granted: true }
  | { readonly granted: false; readonly waitMs: number };

/** Admission control consulted before each attempt. */
export interface Limiter {
  /** Admits one request, or says how long to wait before asking again. */
  acquire(): LimiterDecision | Promise<LimiterDecision>;
  /** Holds every request for `retryAfterMs`, after a 429. */
  throttle?(request: { readonly retryAfterMs: number }): void | Promise<void>;
}

/** Limits to stay under. */
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
 * Fills a partial set of limits from `base` and checks them.
 *
 * @throws {RangeError} a limit that is not a positive finite number, or a
 * burst below one.
 */
export function resolveRateLimits(
  limits: Partial<RateLimits> = {},
  base: RateLimits = DEFAULT_RATE_LIMITS,
): RateLimits {
  const merged = { ...base, ...limits };
  for (const name of ["requestsPerSecond", "burst"] as const) {
    const value = merged[name];
    if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
      throw new RangeError(`${name} must be a positive number, got ${value}`);
    }
  }
  if (merged.burst < 1) {
    throw new RangeError(`burst must be at least 1, got ${merged.burst}`);
  }
  return Object.freeze({
    requestsPerSecond: merged.requestsPerSecond,
    burst: merged.burst,
  });
}

/** A bucket's state, for dashboards and tests. */
export interface BucketSnapshot {
  readonly limits: RateLimits;
  /** Requests that could start now. */
  readonly available: number;
  /** Until when a server `retry-after` holds every request, in epoch ms. */
  readonly blockedUntil: number;
}

/** The bucket arithmetic with time passed in: deterministic and atomic. */
export class TokenBucket {
  #limits: RateLimits;
  #available: number;
  #updated: number;
  #blockedUntil = 0;

  constructor(limits: RateLimits, now: number) {
    this.#limits = resolveRateLimits(limits);
    this.#available = this.#limits.burst;
    this.#updated = now;
  }

  #refill(now: number): void {
    const seconds = Math.max(0, now - this.#updated) / 1000;
    this.#updated = Math.max(this.#updated, now);
    this.#available = Math.min(
      this.#limits.burst,
      this.#available + seconds * this.#limits.requestsPerSecond,
    );
  }

  /** Admits one request, or says how long until one could start. */
  acquire(now: number): LimiterDecision {
    this.#refill(now);
    let wait = Math.max(0, this.#blockedUntil - now);
    if (this.#available < 1) {
      wait = Math.max(
        wait,
        (1 - this.#available) / this.#limits.requestsPerSecond * 1000,
      );
    }
    if (wait > 0) {
      return { granted: false, waitMs: Math.max(1, Math.ceil(wait)) };
    }
    this.#available -= 1;
    return { granted: true };
  }

  /** Holds every request until `retryAfterMs` from now. */
  throttle(now: number, retryAfterMs: number): void {
    if (!Number.isFinite(retryAfterMs) || retryAfterMs < 0) {
      throw new RangeError(
        `retryAfterMs must be non-negative, got ${retryAfterMs}`,
      );
    }
    this.#blockedUntil = Math.max(this.#blockedUntil, now + retryAfterMs);
  }

  /** Replaces the limits, keeping the level within the new burst. */
  configure(now: number, limits: RateLimits): void {
    this.#refill(now);
    this.#limits = resolveRateLimits(limits);
    this.#available = Math.min(this.#available, this.#limits.burst);
  }

  /** The state as of `now`. */
  snapshot(now: number): BucketSnapshot {
    this.#refill(now);
    return {
      limits: this.#limits,
      available: this.#available,
      blockedUntil: this.#blockedUntil,
    };
  }
}

/**
 * A limiter in this isolate's memory, for one process or for tests. A fleet
 * of Workers shares the Durable Object limiter instead.
 */
export function memoryLimiter(
  options: {
    readonly limits?: Partial<RateLimits>;
    readonly now?: () => number;
  } = {},
): Limiter & { snapshot(): BucketSnapshot } {
  const now = options.now ?? Date.now;
  const bucket = new TokenBucket(resolveRateLimits(options.limits), now());
  return {
    acquire: () => bucket.acquire(now()),
    throttle: ({ retryAfterMs }) => bucket.throttle(now(), retryAfterMs),
    snapshot: () => bucket.snapshot(now()),
  };
}

/** The RPC surface of the `ExeKeyLimiter` Durable Object. */
export interface KeyLimiterApi {
  acquire(): LimiterDecision;
  throttle(request: { readonly retryAfterMs: number }): void;
  /** Replaces some limits and stores them durably; returns the result. */
  configure(limits: Partial<RateLimits>): Promise<RateLimits>;
  snapshot(): BucketSnapshot;
}

/**
 * A {@link Limiter} backed by the `ExeKeyLimiter` Durable Object named
 * `name`: use the SSH key's fingerprint, since the server's limit is per key.
 */
export function durableLimiter(
  namespace: DurableObjectNamespace<KeyLimiterApi>,
  name: string,
): Limiter {
  const stub = () => namespace.getByName(name);
  return {
    acquire: () => stub().acquire(),
    throttle: (request) => stub().throttle(request),
  };
}

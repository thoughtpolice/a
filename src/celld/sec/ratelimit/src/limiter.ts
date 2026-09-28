// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * {@link RateLimiter}, the interface every limiter here implements, and
 * the in-memory ones: {@link LocalLimiter} (synchronous, for one isolate or
 * one Durable Object) and {@link memoryLimiter} (the same behind the
 * asynchronous interface, for tests and single-process use).
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
  checkKey,
  type Cost,
  type Policy,
  type ResolvedPolicy,
  resolvePolicies,
} from "./policy.ts";

/** Options for {@link RateLimiter.limit}. */
export interface LimitOptions {
  /** Units the request spends, from every policy or by name; default 1. */
  readonly cost?: Cost;
  /**
   * Admit a request that would have to wait up to this long, reserving its
   * slot and saying how long to wait in `delayMs`, instead of refusing it.
   * For pacing work the caller will do anyway, such as calls to an
   * upstream with its own limit. Default 0: refuse.
   */
  readonly maxDelayMs?: number;
}

/**
 * Options for {@link RateLimiter.peek}, {@link RateLimiter.refund} and
 * {@link RateLimiter.charge}.
 */
export interface CostOptions {
  /** Units, from every policy or by name; default 1. */
  readonly cost?: Cost;
}

/** Options for {@link RateLimiter.hold}. */
export interface HoldOptions {
  /** How long, in milliseconds: 0 to 400 days. */
  readonly forMs: number;
}

/**
 * A set of policies applied to keys. Every policy must admit a request,
 * and then every policy charges it, as one step: a refused request spends
 * nothing.
 */
export interface RateLimiter {
  /** The limiter's name, which separates its keys from other limiters'. */
  readonly name: string;
  readonly policies: readonly ResolvedPolicy[];
  /** Admits and charges a request, or refuses it and charges nothing. */
  limit(key: string, options?: LimitOptions): Promise<Decision>;
  /** Says whether a request of `cost` would be admitted, spending nothing. */
  peek(key: string, options?: CostOptions): Promise<Decision>;
  /**
   * Gives back units an admitted request spent, as when a login attempt
   * charged up front turns out to have succeeded.
   */
  refund(key: string, options?: CostOptions): Promise<void>;
  /**
   * Spends units whether or not the key has them, past its burst if need
   * be; the key is then refused until the debt is paid off. For costs
   * known only afterwards, such as the tokens an answer used.
   */
  charge(key: string, options?: CostOptions): Promise<void>;
  /**
   * Refuses every request of the key for `forMs`, whatever the policies
   * say, as an upstream's `Retry-After` asks. A request that may wait
   * (`maxDelayMs`) is admitted to start when the hold ends. A hold never
   * shortens one in place; `reset` lifts it.
   */
  hold(key: string, options: HoldOptions): Promise<void>;
  /** Forgets everything the key spent, and any hold. */
  reset(key: string): Promise<void>;
}

/** Options for {@link LocalLimiter} and {@link memoryLimiter}. */
export interface LocalLimiterOptions {
  /** Default `local`. */
  readonly name?: string;
  readonly policies: readonly Policy[];
  /** Milliseconds since the epoch; default `Date.now`. */
  readonly now?: () => number;
  /**
   * The most keys kept. Past it the least recently used key is forgotten,
   * which gives it its full burst back, so size this above the number of
   * keys that can be busy at once. Default 10,000.
   */
  readonly maxKeys?: number;
}

const NAME = /^[A-Za-z0-9_.:-]{1,128}$/;

/** Checks a limiter name: 1 to 128 of `A-Z a-z 0-9 _ . : -`. */
export function checkLimiterName(name: unknown): string {
  if (typeof name !== "string" || !NAME.test(name)) {
    throw new TypeError(
      `a limiter name is 1 to 128 of A-Z, a-z, 0-9, _, ., : and -, got ${
        JSON.stringify(name)
      }`,
    );
  }
  return name;
}

/**
 * Checks call options: only `cost`, and `maxDelayMs` where `delay` allows
 * it. Returns them, or `{}` for none.
 */
export function checkOptions(
  options: LimitOptions | undefined,
  delay: boolean,
): LimitOptions {
  if (options === undefined) return {};
  if (typeof options !== "object" || options === null) {
    throw new TypeError("options must be an object");
  }
  for (const key of Object.keys(options)) {
    if (key !== "cost" && !(delay && key === "maxDelayMs")) {
      throw new TypeError(`no option ${JSON.stringify(key)}`);
    }
  }
  return options;
}

/** Checks {@link HoldOptions} and returns `forMs`. */
export function checkHoldOptions(options: HoldOptions): number {
  if (typeof options !== "object" || options === null) {
    throw new TypeError("hold takes { forMs }");
  }
  for (const key of Object.keys(options)) {
    if (key !== "forMs") {
      throw new TypeError(`no option ${JSON.stringify(key)}`);
    }
  }
  return checkHold(options.forMs);
}

/** What a {@link LocalLimiter} keeps for one key. */
interface Entry {
  readonly states: readonly (KeyState | null)[];
  readonly hold: KeyState | null;
}

/**
 * A limiter in memory, answering synchronously: it limits only what goes
 * through this object, so it suits one Durable Object (a connection's
 * message rate, say) or one isolate. Keys are kept in recency order and
 * bounded by `maxKeys`.
 */
export class LocalLimiter {
  readonly name: string;
  readonly policies: readonly ResolvedPolicy[];
  readonly #now: () => number;
  readonly #maxKeys: number;
  readonly #keys = new Map<string, Entry>();

  constructor(options: LocalLimiterOptions) {
    if (typeof options !== "object" || options === null) {
      throw new TypeError("LocalLimiter takes an options object");
    }
    this.name = checkLimiterName(options.name ?? "local");
    this.policies = resolvePolicies(options.policies);
    this.#now = options.now ?? Date.now;
    const maxKeys = options.maxKeys ?? 10_000;
    if (!Number.isSafeInteger(maxKeys) || maxKeys < 1) {
      throw new RangeError("maxKeys must be a whole number from 1");
    }
    this.#maxKeys = maxKeys;
  }

  /** How many keys it holds state for. */
  get size(): number {
    return this.#keys.size;
  }

  #read(key: string): Entry {
    return this.#keys.get(key) ??
      { states: this.policies.map(() => null), hold: null };
  }

  /**
   * Stores a key's states and hold as its most recent use; all idle drops
   * it.
   */
  #write(
    key: string,
    now: number,
    states: readonly (KeyState | null)[],
    held: KeyState | null,
  ): void {
    this.#keys.delete(key);
    const live = held !== null && held.at + held.ahead > now ? held : null;
    if (live === null && states.every((state) => state === null)) return;
    this.#keys.set(key, { states: [...states], hold: live });
    while (this.#keys.size > this.#maxKeys) {
      this.#keys.delete(this.#keys.keys().next().value!);
    }
  }

  /** {@link RateLimiter.limit}, synchronously. */
  limit(key: string, options: LimitOptions = {}): Decision {
    checkKey(key);
    const checked = checkOptions(options, true);
    const cost = checkCost(checked.cost ?? 1, this.policies);
    const maxDelayMs = checkDelay(checked.maxDelayMs ?? 0);
    const now = this.#now();
    const entry = this.#read(key);
    const result = evaluate(this.policies, entry.states, now, cost, {
      maxDelayMs,
      hold: entry.hold,
    });
    this.#write(key, now, result.states, entry.hold);
    return result.decision;
  }

  /** {@link RateLimiter.peek}, synchronously. */
  peek(key: string, options: CostOptions = {}): Decision {
    checkKey(key);
    const cost = checkCost(
      checkOptions(options, false).cost ?? 1,
      this.policies,
    );
    const entry = this.#read(key);
    return evaluate(this.policies, entry.states, this.#now(), cost, {
      commit: false,
      hold: entry.hold,
    }).decision;
  }

  /** {@link RateLimiter.refund}, synchronously. */
  refund(key: string, options: CostOptions = {}): void {
    checkKey(key);
    const cost = checkCost(
      checkOptions(options, false).cost ?? 1,
      this.policies,
    );
    const entry = this.#keys.get(key);
    if (entry === undefined) return;
    const now = this.#now();
    this.#write(
      key,
      now,
      refund(this.policies, entry.states, now, cost),
      entry.hold,
    );
  }

  /** {@link RateLimiter.charge}, synchronously. */
  charge(key: string, options: CostOptions = {}): void {
    checkKey(key);
    const cost = checkCost(
      checkOptions(options, false).cost ?? 1,
      this.policies,
      true,
    );
    const entry = this.#read(key);
    const now = this.#now();
    this.#write(
      key,
      now,
      charge(this.policies, entry.states, now, cost),
      entry.hold,
    );
  }

  /** {@link RateLimiter.hold}, synchronously. */
  hold(key: string, options: HoldOptions): void {
    checkKey(key);
    const forMs = checkHoldOptions(options);
    const entry = this.#read(key);
    const now = this.#now();
    this.#write(key, now, entry.states, hold(entry.hold, now, forMs));
  }

  /** {@link RateLimiter.reset}, synchronously. */
  reset(key: string): void {
    checkKey(key);
    this.#keys.delete(key);
  }
}

/**
 * A {@link RateLimiter} in this isolate's memory, a {@link LocalLimiter}
 * behind the asynchronous interface. It limits only the requests one
 * isolate sees, which a fleet spreads over many, so use it for tests and
 * single-process programs; a fleet shares a `durableLimiter`.
 */
export function memoryLimiter(options: LocalLimiterOptions): RateLimiter {
  const local = new LocalLimiter({ name: "memory", ...options });
  const run = <T>(fn: () => T): Promise<T> => {
    try {
      return Promise.resolve(fn());
    } catch (error) {
      return Promise.reject(error);
    }
  };
  return Object.freeze({
    name: local.name,
    policies: local.policies,
    limit: (key: string, options?: LimitOptions) =>
      run(() => local.limit(key, options)),
    peek: (key: string, options?: CostOptions) =>
      run(() => local.peek(key, options)),
    refund: (key: string, options?: CostOptions) =>
      run(() => local.refund(key, options)),
    charge: (key: string, options?: CostOptions) =>
      run(() => local.charge(key, options)),
    hold: (key: string, options: HoldOptions) =>
      run(() => local.hold(key, options)),
    reset: (key: string) => run(() => local.reset(key)),
  });
}

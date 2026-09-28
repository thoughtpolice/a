// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * {@link Policy}: how many units one key may spend over how long, and the
 * checks every limiter runs on its policies, keys and costs.
 *
 * @module
 */

/**
 * A length of time: a number of seconds, or an ISO 8601 duration such as
 * `"PT15M"` or `"P1D"` (without years or months, which have no fixed
 * length).
 */
export type Duration = number | string;

/**
 * A limit on each key: `limit` units per `window` on average, and at most
 * `burst` at once after the key has been idle. `{ limit: 100, window:
 * "PT1M" }` admits 100 requests at once, then one every 600 ms.
 */
export interface Policy {
  /**
   * Names the policy in `RateLimit` headers and in storage: 1 to 64 of
   * `a-z`, `0-9`, `_` and `-`. Policies of one limiter have distinct names.
   */
  readonly name: string;
  /** Units a key may spend per window, on average: a whole number from 1. */
  readonly limit: number;
  /** The window, from 1 ms to 400 days. */
  readonly window: Duration;
  /**
   * Units a key may spend at once after being idle: a whole number from 1.
   * Default `limit`.
   */
  readonly burst?: number;
}

/** A checked {@link Policy}, with the window in milliseconds. */
export interface ResolvedPolicy {
  readonly name: string;
  readonly limit: number;
  readonly windowMs: number;
  readonly burst: number;
}

/** The longest window: 400 days. */
export const MAX_WINDOW_MS = 400 * 86_400_000;
/** The largest `limit` or `burst`. */
export const MAX_UNITS = 1_000_000_000;
/**
 * The shortest time one unit may take (`window / limit`): a microsecond,
 * so a million units a second. Below that, one epoch millisecond value
 * cannot hold the arithmetic precisely.
 */
export const MIN_INTERVAL_MS = 0.001;
/** The longest key, in UTF-8 bytes. */
export const MAX_KEY_BYTES = 4096;
/** The most policies one limiter may have. */
export const MAX_POLICIES = 8;

const NAME = /^[a-z0-9_-]{1,64}$/;

function wholeUnits(value: unknown, what: string): number {
  if (
    typeof value !== "number" || !Number.isSafeInteger(value) || value < 1 ||
    value > MAX_UNITS
  ) {
    throw new RangeError(
      `${what} must be a whole number from 1 to ${MAX_UNITS}, got ${
        String(value)
      }`,
    );
  }
  return value;
}

/**
 * `duration` in milliseconds. Throws a `RangeError` for anything but a
 * finite, non-negative number of seconds or an ISO 8601 duration without
 * years or months.
 */
export function durationMs(duration: Duration, what: string): number {
  if (typeof duration === "number") {
    if (!Number.isFinite(duration) || duration < 0) {
      throw new RangeError(`${what} must be a non-negative number of seconds`);
    }
    return duration * 1000;
  }
  let parsed: Temporal.Duration | null = null;
  if (typeof duration === "string") {
    try {
      parsed = Temporal.Duration.from(duration);
    } catch {
      parsed = null;
    }
  }
  if (
    parsed === null || parsed.sign < 0 || parsed.years !== 0 ||
    parsed.months !== 0
  ) {
    throw new RangeError(
      `${what} must be seconds or an ISO 8601 duration without years or months, got ${
        JSON.stringify(duration)
      }`,
    );
  }
  return (parsed.weeks * 7 + parsed.days) * 86_400_000 +
    parsed.hours * 3_600_000 + parsed.minutes * 60_000 +
    parsed.seconds * 1000 + parsed.milliseconds +
    parsed.microseconds / 1000 + parsed.nanoseconds / 1_000_000;
}

function checkFields(
  policy: object,
  allowed: readonly string[],
): asserts policy is Record<string, unknown> {
  for (const key of Object.keys(policy)) {
    if (!allowed.includes(key)) {
      throw new TypeError(`a policy has no option ${JSON.stringify(key)}`);
    }
  }
}

function checked(
  name: unknown,
  limitValue: unknown,
  windowMs: number,
  burstValue: unknown,
): ResolvedPolicy {
  if (typeof name !== "string" || !NAME.test(name)) {
    throw new TypeError(
      `a policy name is 1 to 64 of a-z, 0-9, _ and -, got ${
        JSON.stringify(name)
      }`,
    );
  }
  const what = `policy ${name}`;
  const limit = wholeUnits(limitValue, `${what}: limit`);
  const burst = burstValue === undefined
    ? limit
    : wholeUnits(burstValue, `${what}: burst`);
  if (!(windowMs >= 1 && windowMs <= MAX_WINDOW_MS)) {
    throw new RangeError(`${what}: window must be from 1 ms to 400 days`);
  }
  if (windowMs / limit < MIN_INTERVAL_MS) {
    throw new RangeError(
      `${what}: at most a million units a second (limit / window)`,
    );
  }
  return Object.freeze({ name, limit, windowMs, burst });
}

/** Checks one policy; throws a `RangeError` or `TypeError` for a bad one. */
export function resolvePolicy(policy: Policy): ResolvedPolicy {
  if (typeof policy !== "object" || policy === null) {
    throw new TypeError("a policy must be an object");
  }
  checkFields(policy, ["name", "limit", "window", "burst"]);
  const name = typeof policy.name === "string" ? policy.name : "?";
  return checked(
    policy.name,
    policy.limit,
    durationMs(policy.window as Duration, `policy ${name}: window`),
    policy.burst,
  );
}

/**
 * Checks a resolved policy again, as a Durable Object does with the
 * policies an RPC hands it.
 */
export function checkResolvedPolicy(policy: ResolvedPolicy): ResolvedPolicy {
  if (typeof policy !== "object" || policy === null) {
    throw new TypeError("a policy must be an object");
  }
  checkFields(policy, ["name", "limit", "windowMs", "burst"]);
  return checked(
    policy.name,
    policy.limit,
    typeof policy.windowMs === "number" ? policy.windowMs : NaN,
    policy.burst,
  );
}

/**
 * Checks a limiter's policies: one to {@link MAX_POLICIES}, with distinct
 * names. Resolved policies are checked again, so a {@link ResolvedPolicy}
 * that crossed an RPC boundary is trusted only after this.
 */
export function resolvePolicies(
  policies: readonly (Policy | ResolvedPolicy)[],
): readonly ResolvedPolicy[] {
  if (
    !Array.isArray(policies) || policies.length === 0 ||
    policies.length > MAX_POLICIES
  ) {
    throw new RangeError(
      `a limiter has 1 to ${MAX_POLICIES} policies, got ${
        Array.isArray(policies) ? policies.length : typeof policies
      }`,
    );
  }
  const seen = new Set<string>();
  const resolved = policies.map((policy) => {
    const checked = typeof policy === "object" && policy !== null &&
        "windowMs" in policy
      ? checkResolvedPolicy(policy)
      : resolvePolicy(policy as Policy);
    if (seen.has(checked.name)) {
      throw new TypeError(`two policies are named ${checked.name}`);
    }
    seen.add(checked.name);
    return checked;
  });
  return Object.freeze(resolved);
}

/**
 * Checks a key: a non-empty string of at most {@link MAX_KEY_BYTES} UTF-8
 * bytes.
 */
export function checkKey(key: unknown): string {
  if (typeof key !== "string" || key === "") {
    throw new TypeError("a rate limit key must be a non-empty string");
  }
  if (
    key.length > MAX_KEY_BYTES ||
    new TextEncoder().encode(key).length > MAX_KEY_BYTES
  ) {
    throw new RangeError(
      `a rate limit key is at most ${MAX_KEY_BYTES} UTF-8 bytes`,
    );
  }
  return key;
}

/**
 * What a request spends: a number of units from every policy, or units by
 * policy name, where a policy left out spends none. `{ requests: 1,
 * tokens: 500 }` charges a request against one policy and its tokens
 * against another.
 */
export type Cost = number | { readonly [policy: string]: number };

function units(value: unknown, what: string): number {
  if (
    typeof value !== "number" || !Number.isSafeInteger(value) || value < 0 ||
    value > MAX_UNITS
  ) {
    throw new RangeError(
      `${what} must be a whole number from 0 to ${MAX_UNITS}, got ${
        String(value)
      }`,
    );
  }
  return value;
}

/**
 * Checks a cost against the policies and returns each policy's share, in
 * their order. A share is a whole number from 0 (a question that spends
 * nothing) to the policy's burst, since a larger one could never be
 * admitted; with `overdraw`, as for a charge, it may be up to
 * {@link MAX_UNITS}.
 */
export function checkCost(
  cost: unknown,
  policies: readonly ResolvedPolicy[],
  overdraw = false,
): number[] {
  let shares: number[];
  if (typeof cost === "number") {
    const each = units(cost, "a cost");
    shares = policies.map(() => each);
  } else if (
    typeof cost === "object" && cost !== null && !Array.isArray(cost)
  ) {
    const byName = cost as Record<string, unknown>;
    for (const name of Object.keys(byName)) {
      if (!policies.some((policy) => policy.name === name)) {
        throw new TypeError(
          `a cost names no policy of the limiter: ${JSON.stringify(name)}`,
        );
      }
    }
    shares = policies.map((policy) =>
      Object.hasOwn(byName, policy.name)
        ? units(byName[policy.name], `policy ${policy.name}'s cost`)
        : 0
    );
  } else {
    throw new TypeError("a cost is a number, or units by policy name");
  }
  if (!overdraw) {
    policies.forEach((policy, i) => {
      if (shares[i] > policy.burst) {
        throw new RangeError(
          `a cost of ${
            shares[i]
          } exceeds policy ${policy.name}'s burst of ${policy.burst}, so it could never be admitted`,
        );
      }
    });
  }
  return shares;
}

/** Checks a delay a caller will wait: 0 to 2^31 - 1 ms (a timer's range). */
export function checkDelay(delayMs: unknown): number {
  if (
    typeof delayMs !== "number" || !Number.isFinite(delayMs) || delayMs < 0 ||
    delayMs > 2_147_483_647
  ) {
    throw new RangeError(
      `maxDelayMs must be a number from 0 to 2147483647, got ${
        String(delayMs)
      }`,
    );
  }
  return delayMs;
}

/** Checks how long to hold a key: 0 to {@link MAX_WINDOW_MS}. */
export function checkHold(forMs: unknown): number {
  if (
    typeof forMs !== "number" || !Number.isFinite(forMs) || forMs < 0 ||
    forMs > MAX_WINDOW_MS
  ) {
    throw new RangeError(
      `forMs must be a number from 0 to ${MAX_WINDOW_MS} (400 days), got ${
        String(forMs)
      }`,
    );
  }
  return forMs;
}

/**
 * Fills a client's named limits from its defaults and checks them: an
 * object with only the defaults' names, each a whole number from 1. For
 * libraries that state an upstream's limits in its own terms (requests a
 * minute, tokens a second) before turning them into policies.
 *
 * @throws {TypeError} limits that are not an object, or a name the
 * defaults do not have.
 * @throws {RangeError} a limit that is not a whole number from 1.
 */
export function resolveLimits<T extends { readonly [K in keyof T]: number }>(
  limits: Partial<T> | undefined,
  defaults: T,
): T {
  const given = limits ?? {};
  if (typeof given !== "object" || given === null || Array.isArray(given)) {
    throw new TypeError("limits must be an object");
  }
  for (const name of Object.keys(given)) {
    if (!Object.hasOwn(defaults, name)) {
      throw new TypeError(`no rate limit ${JSON.stringify(name)}`);
    }
  }
  const merged: Record<string, number> = { ...defaults };
  for (const [name, value] of Object.entries(given)) {
    if (value !== undefined) merged[name] = value;
  }
  for (const [name, value] of Object.entries(merged)) {
    if (!Number.isSafeInteger(value) || value < 1) {
      throw new RangeError(
        `${name} must be a whole number from 1, got ${value}`,
      );
    }
  }
  return Object.freeze(merged) as unknown as T;
}

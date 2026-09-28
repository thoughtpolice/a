// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * The generic cell rate algorithm (GCRA), with time passed in: no clock and
 * no I/O, so it is deterministic under test and atomic inside a Durable
 * Object method.
 *
 * A policy of `limit` units per `window` with a `burst` spends one unit
 * every `T = window / limit` on average. Each key keeps, per policy, its
 * theoretical arrival time (TAT): when the key would be idle again if it
 * spent nothing more. A request of `cost` units at `now` moves it to
 * `max(TAT, now) + cost * T`, and is admitted when that is at most
 * `burst * T` ahead of `now`. So a key never spends more than `burst` units
 * at once, nor more than `burst + limit * (t / window)` over any time `t`,
 * and an idle key keeps nothing: a TAT at or before `now` is the same as
 * none, and is dropped.
 *
 * A request's cost may differ by policy (requests against one, tokens
 * against another); a policy it costs nothing is only asked whether the key
 * is in debt there. A key may also be held (an upstream's `Retry-After`):
 * nothing is admitted before the hold ends, and a request that may wait
 * starts spending when it does.
 *
 * The TAT is kept as a {@link KeyState}: the time of the last decision and
 * how far ahead of it the TAT lay. An epoch millisecond count holds only
 * about a quarter of a microsecond of precision, which would round every
 * update by up to 2% of the shortest interval (a microsecond) and drift in
 * one direction; an offset from the decision time keeps full precision.
 *
 * @module
 */

import { MAX_WINDOW_MS, type ResolvedPolicy } from "./policy.ts";

/**
 * A key's state under one policy: the time of the last decision that
 * moved it (`at`, epoch milliseconds) and how far the TAT lay ahead of
 * that (`ahead`, milliseconds, positive). The TAT is `at + ahead`.
 */
export interface KeyState {
  readonly at: number;
  readonly ahead: number;
}

/**
 * One policy's state for a key, after a decision. While the key is held,
 * nothing can be spent under any policy until the hold ends.
 */
export interface PolicyStatus {
  readonly name: string;
  readonly limit: number;
  readonly windowMs: number;
  readonly burst: number;
  /** Units the key could spend now: 0 while it is held. */
  readonly remaining: number;
  /**
   * Milliseconds until the key is back to `burst`, rounded up, and no
   * sooner than the end of a hold.
   */
  readonly resetMs: number;
}

/** A limiter's answer. */
export interface Decision {
  /** Whether the request was admitted (and its cost spent). */
  readonly allowed: boolean;
  /**
   * How long an admitted request waits before it acts, in milliseconds:
   * 0 unless the call allowed a delay (`maxDelayMs`) and needed it.
   */
  readonly delayMs: number;
  /**
   * For a refused request, milliseconds until the same request would be
   * admitted at once if the key spent nothing meanwhile; 0 when admitted.
   */
  readonly retryAfterMs: number;
  /** The fewest units left across the policies; 0 while the key is held. */
  readonly remaining: number;
  /** Each policy's state, in the limiter's order. */
  readonly policies: readonly PolicyStatus[];
}

/** {@link evaluate}'s result: the decision and the states to store. */
export interface Evaluation {
  readonly decision: Decision;
  /**
   * Each policy's state after the decision, or null when idle (drop it).
   * Unchanged states are the objects passed in, so a caller can skip
   * writing them.
   */
  readonly states: readonly (KeyState | null)[];
  /** Whether any state changed, and so needs writing. */
  readonly changed: boolean;
  /**
   * Milliseconds until a request of one unit from every policy would be
   * admitted, which a cache of refusals may rely on until then; 0 when one
   * would be now.
   */
  readonly nextMs: number;
}

/** Options for {@link evaluate}. */
export interface EvaluateOptions {
  /** Admit a request that would wait up to this long; default 0. */
  readonly maxDelayMs?: number;
  /**
   * Whether an admitted request moves the states; default true. With
   * false nothing moves either way: the decision says what would happen.
   */
  readonly commit?: boolean;
  /** The key's hold, from {@link hold}; null or undefined for none. */
  readonly hold?: KeyState | null;
}

/**
 * Slack for floating-point rounding, in milliseconds: far below one unit's
 * interval (at least a microsecond).
 */
const EPSILON = 1e-7;

function interval(policy: ResolvedPolicy): number {
  return policy.windowMs / policy.limit;
}

/** How far the state's TAT lies ahead of `now`; 0 when idle. */
function aheadOf(state: KeyState | null | undefined, now: number): number {
  if (state === null || state === undefined) return 0;
  return Math.max(0, (state.at - now) + state.ahead);
}

function stateAt(now: number, ahead: number): KeyState | null {
  return ahead <= EPSILON ? null : Object.freeze({ at: now, ahead });
}

function whole(ms: number): number {
  return ms > EPSILON ? Math.ceil(ms - EPSILON) : 0;
}

/** Each policy's share of `cost`: the same number, or one per policy. */
function sharesOf(
  policies: readonly ResolvedPolicy[],
  cost: number | readonly number[],
): readonly number[] {
  return typeof cost === "number" ? policies.map(() => cost) : cost;
}

/**
 * Decides a request of `cost` units (one number for every policy, or one
 * per policy) for one key at `now`, given each policy's state (null or
 * undefined for idle). The request is admitted only when every policy
 * admits it and the key is not held, within `maxDelayMs`; then each state
 * it costs something moves, otherwise none does.
 */
export function evaluate(
  policies: readonly ResolvedPolicy[],
  states: readonly (KeyState | null | undefined)[],
  now: number,
  cost: number | readonly number[],
  options: EvaluateOptions = {},
): Evaluation {
  const { maxDelayMs = 0, commit = true } = options;
  const shares = sharesOf(policies, cost);
  const held = aheadOf(options.hold, now);
  const current = policies.map((_, i) => aheadOf(states[i], now));
  // What the request spends starts when any hold ends.
  const moved = policies.map((policy, i) =>
    shares[i] === 0
      ? current[i]
      : Math.max(current[i], held) + shares[i] * interval(policy)
  );
  let wait = held;
  policies.forEach((policy, i) => {
    wait = Math.max(wait, moved[i] - policy.burst * interval(policy));
  });
  const allowed = wait <= maxDelayMs + EPSILON;
  const keep = allowed && commit;
  const after = keep ? moved : current;
  const statuses: PolicyStatus[] = [];
  let remaining = Infinity;
  let nextMs = held;
  policies.forEach((policy, i) => {
    const t = interval(policy);
    const ahead = after[i] <= EPSILON ? 0 : after[i];
    const left = held > EPSILON ? 0 : Math.max(
      0,
      Math.floor((policy.burst * t - ahead) / t + EPSILON),
    );
    remaining = Math.min(remaining, left);
    nextMs = Math.max(nextMs, ahead + t - policy.burst * t);
    statuses.push(Object.freeze({
      name: policy.name,
      limit: policy.limit,
      windowMs: policy.windowMs,
      burst: policy.burst,
      remaining: left,
      resetMs: whole(Math.max(ahead, held)),
    }));
  });
  const next = policies.map((_, i) => {
    const state = states[i] ?? null;
    if (keep && shares[i] !== 0) return stateAt(now, moved[i]);
    // Unchanged, but an idle state is dropped all the same.
    return current[i] <= EPSILON ? null : state;
  });
  return {
    decision: Object.freeze({
      allowed,
      delayMs: allowed ? whole(wait) : 0,
      retryAfterMs: allowed ? 0 : whole(wait),
      remaining,
      policies: Object.freeze(statuses),
    }),
    states: next,
    changed: next.some((state, i) => state !== (states[i] ?? null)),
    nextMs: whole(nextMs),
  };
}

/** A state a change left alone: the same object, or null once idle. */
function untouched(
  state: KeyState | null | undefined,
  now: number,
): KeyState | null {
  return aheadOf(state, now) <= EPSILON ? null : state ?? null;
}

/**
 * Gives `cost` units back to a key: each state moves back by its share of
 * `cost` intervals, but not before `now`. Returns the states to store (null
 * for idle); a state the cost has no share of is the object passed in, so
 * a caller can skip writing it.
 */
export function refund(
  policies: readonly ResolvedPolicy[],
  states: readonly (KeyState | null | undefined)[],
  now: number,
  cost: number | readonly number[],
): (KeyState | null)[] {
  const shares = sharesOf(policies, cost);
  return policies.map((policy, i) =>
    shares[i] === 0
      ? untouched(states[i], now)
      : stateAt(now, aheadOf(states[i], now) - shares[i] * interval(policy))
  );
}

/**
 * Spends `cost` units whether or not the key has them: each state moves
 * forward by its share of `cost` intervals, past the burst if need be, so
 * the key is refused until the debt is paid off. Debt stops at
 * {@link MAX_WINDOW_MS} past the burst. Returns the states to store; as
 * with {@link refund}, one the cost has no share of is the object passed in.
 */
export function charge(
  policies: readonly ResolvedPolicy[],
  states: readonly (KeyState | null | undefined)[],
  now: number,
  cost: number | readonly number[],
): (KeyState | null)[] {
  const shares = sharesOf(policies, cost);
  return policies.map((policy, i) => {
    if (shares[i] === 0) return untouched(states[i], now);
    const t = interval(policy);
    return stateAt(
      now,
      Math.min(
        aheadOf(states[i], now) + shares[i] * t,
        policy.burst * t + MAX_WINDOW_MS,
      ),
    );
  });
}

/**
 * A key's hold after holding it for `forMs` from `now`: it ends at the
 * later of that and the hold in place, so a hold is never shortened. Null
 * when neither lasts past `now`.
 */
export function hold(
  state: KeyState | null | undefined,
  now: number,
  forMs: number,
): KeyState | null {
  return stateAt(now, Math.max(aheadOf(state, now), forMs));
}

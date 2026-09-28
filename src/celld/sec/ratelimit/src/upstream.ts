// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * {@link UpstreamLimit}: a client's side of a limiter it shares with the
 * other callers of an upstream API, as `@celld/api/jev` and
 * `@celld/api/exedev` use it.
 *
 * @module
 */

import { MAX_TIMER_MS } from "@celld/core/bounds";
import { rejectOnAbort, type Runtime } from "@celld/http";
import type { Decision } from "./gcra.ts";
import type { RateLimiter } from "./limiter.ts";
import {
  checkCost,
  checkKey,
  type Cost,
  type ResolvedPolicy,
} from "./policy.ts";

/** Options for {@link UpstreamLimit}. */
export interface UpstreamLimitOptions {
  /**
   * The key every caller of the upstream shares: an account, an API key.
   * Default `"default"`.
   */
  readonly key?: string;
  /**
   * What one call spends up front, or a function of the limiter's policies
   * that says; default one unit of every policy.
   */
  readonly cost?: Cost | ((policies: readonly ResolvedPolicy[]) => Cost);
  /** Hears the limiter's failures, which never stop a call. */
  readonly onError?: (error: unknown) => void;
}

/** Options for {@link UpstreamLimit.admit}. */
export interface AdmitOptions {
  /** When the caller stops waiting, on `runtime`'s clock. */
  readonly deadline: number;
  /** The clock and the sleep between refusals. */
  readonly runtime: Pick<Runtime, "now" | "sleep">;
  /** Stops the wait: `admit` then rejects with the signal's reason. */
  readonly signal?: AbortSignal;
}

/**
 * What {@link UpstreamLimit.admit} decided: `admitted` (the cost is spent),
 * `refused` (the limiter would not admit the call before the deadline), or
 * `unavailable` (the limiter failed; `onError` heard why).
 */
export type Admission = "admitted" | "refused" | "unavailable";

/**
 * A client's side of a limiter shared with the other callers of an
 * upstream API. `admit` waits out the limiter's refusals until a deadline;
 * `giveBack` refunds an admission whose call was never sent; `charge` and
 * `refund` settle costs known only from the answer, such as tokens; `hold`
 * pauses every caller of the key for an upstream's `Retry-After`.
 *
 * The limiter only helps the client stay under the upstream's limits: the
 * upstream's 429 stays the authority. So the limiter's failures never stop
 * a call. They go to `onError`, `admit` answers `unavailable`, and the
 * other methods resolve all the same.
 */
export class UpstreamLimit {
  readonly limiter: RateLimiter;
  readonly key: string;
  readonly cost: Cost;
  readonly #onError: (error: unknown) => void;

  /**
   * @throws {TypeError} a limiter that is not one, or a bad key or cost.
   * @throws {RangeError} a cost some policy could never admit.
   */
  constructor(limiter: RateLimiter, options: UpstreamLimitOptions = {}) {
    if (
      typeof limiter !== "object" || limiter === null ||
      !Array.isArray(limiter.policies) ||
      (["limit", "refund", "charge", "hold"] as const).some((method) =>
        typeof limiter[method] !== "function"
      )
    ) {
      throw new TypeError("limiter must be an @celld/sec/ratelimit limiter");
    }
    this.limiter = limiter;
    this.key = checkKey(options.key ?? "default");
    const cost = typeof options.cost === "function"
      ? options.cost(limiter.policies)
      : options.cost ?? 1;
    checkCost(cost, limiter.policies);
    this.cost = cost;
    this.#onError = options.onError ?? (() => {});
  }

  #report(error: unknown): void {
    try {
      this.#onError(error);
    } catch {
      // A failing reporter must not fail the call.
    }
  }

  /**
   * Waits until the limiter admits one call, sleeping out each refusal,
   * and answers `refused` as soon as the limiter's wait would reach the
   * deadline: it said when it would admit, so asking again sooner cannot
   * help. After `admitted`, give the cost back with {@link giveBack} if
   * the call is not sent. Rejects when `signal` fires, and gives back an
   * admission that arrives afterwards.
   */
  async admit(options: AdmitOptions): Promise<Admission> {
    const { deadline, runtime, signal } = options;
    for (;;) {
      const pending = new Promise<Decision>((resolve) =>
        resolve(this.limiter.limit(this.key, { cost: this.cost }))
      );
      let decision: Decision;
      try {
        decision = signal === undefined
          ? await pending
          : await rejectOnAbort(pending, signal);
      } catch (error) {
        if (signal?.aborted) {
          pending.then(
            (late) => late.allowed ? this.giveBack() : undefined,
            () => {},
          );
          throw error;
        }
        this.#report(error);
        return "unavailable";
      }
      if (decision.allowed) return "admitted";
      const wait = Number.isFinite(decision.retryAfterMs) &&
          decision.retryAfterMs > 0
        ? Math.min(Math.ceil(decision.retryAfterMs), MAX_TIMER_MS)
        : 1;
      if (runtime.now() + wait >= deadline) return "refused";
      await runtime.sleep(wait, signal);
    }
  }

  /** Refunds an admission whose call was never sent. */
  async giveBack(): Promise<void> {
    await this.refund(this.cost);
  }

  /** Spends `cost` more, past the burst if need be. */
  async charge(cost: Cost): Promise<void> {
    try {
      await this.limiter.charge(this.key, { cost });
    } catch (error) {
      this.#report(error);
    }
  }

  /** Gives `cost` back. */
  async refund(cost: Cost): Promise<void> {
    try {
      await this.limiter.refund(this.key, { cost });
    } catch (error) {
      this.#report(error);
    }
  }

  /** Holds every caller of the key for `forMs`, as a `Retry-After` asks. */
  async hold(forMs: number): Promise<void> {
    try {
      await this.limiter.hold(this.key, { forMs });
    } catch (error) {
      this.#report(error);
    }
  }
}

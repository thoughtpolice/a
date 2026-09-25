// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * Pacing calls that share one ChatGPT subscription.
 *
 * A subscription is not metered per request like an API key. It has usage
 * windows (a short one of about five hours and a weekly one, per the
 * `x-codex-*` headers), and when a window is spent every call fails with
 * `usage_limit_reached` until it resets. So the useful controls are
 * different from a token bucket:
 *
 * - **Concurrency.** At most `maxConcurrent` calls in flight at once, so a
 *   burst of agents does not all start (and all fail) together. Each
 *   admission is a lease that the caller releases; a lease that is never
 *   released (a crashed caller) expires after its `leaseMs`.
 * - **Spacing.** At least `minIntervalMs` between starts, if configured.
 * - **Blocking.** When any caller sees a usage limit, a `retry-after`, or
 *   headers saying a window is at 100%, every caller sharing the pacer is
 *   held until the reset, and the client turns a hold longer than its
 *   `maxPacerWaitMs` into an immediate `usage_limit` error rather than
 *   sending requests it knows will fail.
 *
 * {@link PacerState} is the arithmetic, with time passed in. {@link
 * memoryPacer} runs it in one isolate; the `GptPacer` Durable Object in
 * `@celld/api/openai/durable` runs it for a whole fleet and keeps the block
 * durable across restarts.
 *
 * @module
 */

import type { GptErrorKind } from "./errors.ts";
import { exhaustedUntil, type RateLimitSnapshot } from "./ratelimits.ts";
import type { Usage } from "./types.ts";

/** Pacing settings. */
export interface PacerConfig {
  /** Calls in flight at once; default 4. */
  readonly maxConcurrent: number;
  /** Minimum time between starts; default 0. */
  readonly minIntervalMs: number;
  /** The longest lease a caller may ask for; default 30 minutes. */
  readonly maxLeaseMs: number;
  /**
   * How long to hold everyone after a usage limit whose reset time is
   * unknown; default 15 minutes.
   */
  readonly unknownResetBlockMs: number;
}

/** The defaults. `maxConcurrent` 4 is a guess; OpenAI publishes no number. */
export const DEFAULT_PACER_CONFIG: PacerConfig = Object.freeze({
  maxConcurrent: 4,
  minIntervalMs: 0,
  maxLeaseMs: 30 * 60_000,
  unknownResetBlockMs: 15 * 60_000,
});

/** Fills and checks a partial config. */
export function resolvePacerConfig(
  config: Partial<PacerConfig> = {},
  base: PacerConfig = DEFAULT_PACER_CONFIG,
): PacerConfig {
  const merged = { ...base, ...config };
  if (!Number.isInteger(merged.maxConcurrent) || merged.maxConcurrent < 1) {
    throw new RangeError(
      `maxConcurrent must be a positive integer, got ${merged.maxConcurrent}`,
    );
  }
  for (
    const key of ["minIntervalMs", "maxLeaseMs", "unknownResetBlockMs"] as const
  ) {
    const value = merged[key];
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
      throw new RangeError(
        `${key} must be a non-negative number, got ${value}`,
      );
    }
  }
  return Object.freeze({
    maxConcurrent: merged.maxConcurrent,
    minIntervalMs: merged.minIntervalMs,
    maxLeaseMs: Math.max(1, merged.maxLeaseMs),
    unknownResetBlockMs: merged.unknownResetBlockMs,
  });
}

/** Why callers are being held. */
export interface PacerBlock {
  /** Until when, in epoch milliseconds. */
  readonly until: number;
  /** `usage_limit`, `rate_limited`, `overloaded`, `exhausted`, or the caller's. */
  readonly reason: string;
  /** The server's error code, when there was one. */
  readonly code: string | null;
}

/** An admission decision. Plain data, for RPC. */
export type PacerDecision =
  | { readonly granted: true; readonly lease: string }
  | {
    readonly granted: false;
    /** How long to wait before asking again. */
    readonly waitMs: number;
    /** `blocked` (see `block`), `busy` (at concurrency) or `spacing`. */
    readonly reason: "blocked" | "busy" | "spacing";
    readonly block: PacerBlock | null;
  };

/** What a caller reports when its call ends. Plain data. */
export interface PacerReport {
  readonly lease: string;
  /** Rate-limit windows the response reported. */
  readonly rateLimits?: readonly RateLimitSnapshot[];
  readonly usage?: Usage | null;
  /** The failure, if the call failed. */
  readonly error?: {
    readonly kind: GptErrorKind;
    readonly code: string | null;
    readonly retryAfterMs: number | null;
    readonly resetsAt: number | null;
  } | null;
}

/** Totals since the pacer started (or, durably, since it was created). */
export interface PacerTotals {
  readonly calls: number;
  readonly failures: number;
  readonly usageLimits: number;
  readonly inputTokens: number;
  readonly cachedInputTokens: number;
  readonly outputTokens: number;
  readonly reasoningTokens: number;
}

/** A pacer's state, for dashboards and tests. Plain data. */
export interface PacerSnapshot {
  readonly config: PacerConfig;
  readonly inFlight: number;
  readonly block: PacerBlock | null;
  readonly lastStart: number;
  /** The latest windows any caller reported, by limit id. */
  readonly rateLimits: readonly RateLimitSnapshot[];
  readonly totals: PacerTotals;
}

const ZERO_TOTALS: PacerTotals = Object.freeze({
  calls: 0,
  failures: 0,
  usageLimits: 0,
  inputTokens: 0,
  cachedInputTokens: 0,
  outputTokens: 0,
  reasoningTokens: 0,
});

/** The pacing arithmetic, with time and ids passed in: no clock, no I/O. */
export class PacerState {
  #config: PacerConfig;
  #leases = new Map<string, number>();
  #lastStart = 0;
  #block: PacerBlock | null = null;
  #rateLimits = new Map<string, RateLimitSnapshot>();
  #totals: PacerTotals = ZERO_TOTALS;

  constructor(
    config: Partial<PacerConfig> = {},
    restored: {
      readonly block?: PacerBlock | null;
      readonly totals?: PacerTotals;
      readonly rateLimits?: readonly RateLimitSnapshot[];
    } = {},
  ) {
    this.#config = resolvePacerConfig(config);
    this.#block = restored.block ?? null;
    this.#totals = restored.totals ?? ZERO_TOTALS;
    for (const snapshot of restored.rateLimits ?? []) {
      this.#rateLimits.set(snapshot.limitId, snapshot);
    }
  }

  #expire(now: number): void {
    for (const [lease, expires] of this.#leases) {
      if (expires <= now) this.#leases.delete(lease);
    }
    if (this.#block !== null && this.#block.until <= now) this.#block = null;
  }

  /** Admits one call under a new lease `id`, or says how long to wait. */
  acquire(now: number, leaseMs: number, id: string): PacerDecision {
    this.#expire(now);
    if (this.#block !== null) {
      return {
        granted: false,
        waitMs: Math.max(1, this.#block.until - now),
        reason: "blocked",
        block: this.#block,
      };
    }
    if (this.#leases.size >= this.#config.maxConcurrent) {
      const soonest = Math.min(...this.#leases.values());
      return {
        granted: false,
        // Releases usually come long before expiry; poll at least each second.
        waitMs: Math.max(1, Math.min(soonest - now, 1000)),
        reason: "busy",
        block: null,
      };
    }
    const spacing = this.#lastStart + this.#config.minIntervalMs - now;
    if (this.#lastStart > 0 && spacing > 0) {
      return {
        granted: false,
        waitMs: Math.ceil(spacing),
        reason: "spacing",
        block: null,
      };
    }
    const lease = Math.min(Math.max(1, leaseMs), this.#config.maxLeaseMs);
    this.#leases.set(id, now + lease);
    this.#lastStart = now;
    return { granted: true, lease: id };
  }

  /**
   * Ends a lease and learns from the report: usage totals, the latest
   * windows, and whether everyone must now be held.
   */
  release(now: number, report: PacerReport): void {
    this.#leases.delete(report.lease);
    const usage = report.usage ?? null;
    const error = report.error ?? null;
    const totals = this.#totals;
    this.#totals = {
      calls: totals.calls + 1,
      failures: totals.failures + (error === null ? 0 : 1),
      usageLimits: totals.usageLimits + (error?.kind === "usage_limit" ? 1 : 0),
      inputTokens: totals.inputTokens + (usage?.inputTokens ?? 0),
      cachedInputTokens: totals.cachedInputTokens +
        (usage?.cachedInputTokens ?? 0),
      outputTokens: totals.outputTokens + (usage?.outputTokens ?? 0),
      reasoningTokens: totals.reasoningTokens + (usage?.reasoningTokens ?? 0),
    };
    for (const snapshot of report.rateLimits ?? []) {
      this.#rateLimits.set(snapshot.limitId, snapshot);
    }
    if (error?.kind === "usage_limit") {
      this.block(now, {
        until: error.resetsAt !== null && error.resetsAt > now
          ? error.resetsAt
          : now + this.#config.unknownResetBlockMs,
        reason: "usage_limit",
        code: error.code,
      });
    } else if (
      (error?.kind === "rate_limited" || error?.kind === "overloaded") &&
      error.retryAfterMs !== null && error.retryAfterMs > 0
    ) {
      this.block(now, {
        until: now + error.retryAfterMs,
        reason: error.kind,
        code: error.code,
      });
    }
    const exhausted = exhaustedUntil(report.rateLimits ?? [], now);
    if (exhausted !== null) {
      this.block(now, { until: exhausted, reason: "exhausted", code: null });
    }
  }

  /** Holds every caller until `block.until`; a later block wins. */
  block(now: number, block: PacerBlock): boolean {
    this.#expire(now);
    if (block.until <= now) return false;
    if (this.#block !== null && this.#block.until >= block.until) return false;
    this.#block = {
      until: block.until,
      reason: block.reason,
      code: block.code,
    };
    return true;
  }

  /** Lifts any block. */
  unblock(): void {
    this.#block = null;
  }

  /** Replaces some settings. */
  configure(config: Partial<PacerConfig>): PacerConfig {
    this.#config = resolvePacerConfig(config, this.#config);
    return this.#config;
  }

  /** The state as of `now`. */
  snapshot(now: number): PacerSnapshot {
    this.#expire(now);
    return {
      config: this.#config,
      inFlight: this.#leases.size,
      block: this.#block,
      lastStart: this.#lastStart,
      rateLimits: [...this.#rateLimits.values()],
      totals: this.#totals,
    };
  }
}

/**
 * Admission control the client consults before each attempt: `acquire` for
 * a lease, `release` with what the attempt learned. Both may be remote (a
 * Durable Object); results are plain data.
 */
export interface Pacer {
  acquire(
    request: { readonly leaseMs: number },
  ): PacerDecision | Promise<PacerDecision>;
  release(report: PacerReport): void | Promise<void>;
}

/** Options for {@link memoryPacer}. */
export interface MemoryPacerOptions {
  readonly config?: Partial<PacerConfig>;
  /** The clock; default `Date.now`. */
  readonly now?: () => number;
}

/** A pacer in this isolate's memory, for one process or tests. */
export function memoryPacer(
  options: MemoryPacerOptions = {},
): Pacer & {
  snapshot(): PacerSnapshot;
  block(block: PacerBlock): boolean;
  configure(config: Partial<PacerConfig>): PacerConfig;
} {
  const now = options.now ?? Date.now;
  const state = new PacerState(options.config);
  let next = 0;
  return {
    acquire: ({ leaseMs }) => state.acquire(now(), leaseMs, `lease-${++next}`),
    release: (report) => state.release(now(), report),
    snapshot: () => state.snapshot(now()),
    block: (block) => state.block(now(), block),
    configure: (config) => state.configure(config),
  };
}

/**
 * The RPC surface of the `GptPacer` Durable Object. Type its binding with
 * it: `GPT_PACER: DurableObjectNamespace<PacerApi>`.
 */
export interface PacerApi {
  acquire(request: { readonly leaseMs: number }): PacerDecision;
  release(report: PacerReport): Promise<void>;
  /** Holds everyone until `until` (durably); true if it extended the hold. */
  block(block: PacerBlock): Promise<boolean>;
  unblock(): Promise<void>;
  configure(config: Partial<PacerConfig>): Promise<PacerConfig>;
  snapshot(): PacerSnapshot;
}

/**
 * A {@link Pacer} backed by the `GptPacer` object named `name` (one per
 * subscription; default `"default"`), shared by the whole fleet.
 */
export function durablePacer(
  namespace: DurableObjectNamespace<PacerApi>,
  name = "default",
): Pacer {
  const stub = () => namespace.getByName(name);
  return {
    acquire: (request) => stub().acquire(request),
    release: (report) => stub().release(report),
  };
}

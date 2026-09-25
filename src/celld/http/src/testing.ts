// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * Test doubles for HTTP clients and the Workflows that use them: a virtual
 * clock that sleeps instantly, and a Workflow step runner with replay.
 *
 * ```ts
 * const runtime = virtualRuntime();
 * const client = new SomeClient({ fetch, runtime });
 * await client.call();
 * assertEquals(runtime.sleeps, [500]);
 * ```
 *
 * @module
 */

import type { Runtime } from "./runtime.ts";

/** A {@link Runtime} whose clock only moves when something sleeps. */
export interface VirtualRuntime extends Runtime {
  /** Every sleep requested, in order. */
  readonly sleeps: number[];
  /** Moves the clock forward. */
  advance(ms: number): void;
}

/**
 * A runtime for fast, deterministic tests: `sleep` returns at once (still
 * rejecting when its signal aborts) and advances the virtual clock, and
 * `random` returns `random` (default 0.5). The clock starts at `start`
 * (default 1,750,000,000,000, in June 2025). Timers are real, so attempt
 * timeouts are real; keep them short in tests.
 */
export function virtualRuntime(
  options: { readonly start?: number; readonly random?: number } = {},
): VirtualRuntime {
  let now = options.start ?? 1_750_000_000_000;
  const random = options.random ?? 0.5;
  const sleeps: number[] = [];
  return {
    sleeps,
    now: () => now,
    random: () => random,
    advance(ms) {
      now += ms;
    },
    sleep(ms, signal) {
      if (signal?.aborted) return Promise.reject(signal.reason);
      sleeps.push(ms);
      now += ms;
      return Promise.resolve();
    },
    setTimer(ms, callback) {
      const timer = setTimeout(callback, ms);
      return () => clearTimeout(timer);
    },
  };
}

/** A Workflow step runner with replay, for tests; see {@link fakeStep}. */
export interface FakeStep extends WorkflowStep {
  /**
   * What happened, in order: `run <name> #<attempt>`, `threw <error name>:
   * <message>`, `replay <name>`, `sleep <name> <duration>` and
   * `sleepUntil <name> <epoch ms>`.
   */
  readonly log: string[];
  /** Stored results of `do` steps, by name. */
  readonly stored: Map<string, unknown>;
}

const DEFAULT_RETRIES = Object.freeze(
  {
    limit: 5,
    delay: "10 seconds",
    backoff: "exponential",
  } as const,
);

const DEFAULT_TIMEOUT = "10 minutes";

function describe(error: unknown): string {
  return error instanceof Error
    ? `${error.name}: ${error.message}`
    : String(error);
}

/**
 * A `WorkflowStep` with the properties Workflow code relies on, following
 * celld's defaults:
 *
 * - a `do` name that already succeeded returns a structured clone of its
 *   stored result (so does the first run, as the runtime serializes it);
 * - a throwing callback is retried, without waiting, up to its config's
 *   `retries.limit` (five retries when no `retries` is given);
 * - each callback gets a `WorkflowStepContext` with the attempt and the
 *   effective config (`step.count` is always 1);
 * - `sleep` and `sleepUntil` are recorded once per name, not taken;
 * - `waitForEvent` rejects, since no events are ever sent.
 *
 * Run the same code twice with one `fakeStep()` to test replay.
 */
export function fakeStep(): FakeStep {
  const stored = new Map<string, unknown>();
  const slept = new Set<string>();
  const log: string[] = [];
  const step = {
    log,
    stored,
    async do<T>(
      name: string,
      configOrCallback:
        | WorkflowStepConfig
        | ((ctx: WorkflowStepContext) => T | Promise<T>),
      maybeCallback?: (ctx: WorkflowStepContext) => T | Promise<T>,
    ): Promise<T> {
      const config: WorkflowStepConfig = typeof configOrCallback === "function"
        ? {}
        : configOrCallback;
      const callback = typeof configOrCallback === "function"
        ? configOrCallback
        : maybeCallback!;
      if (stored.has(name)) {
        log.push(`replay ${name}`);
        return structuredClone(stored.get(name)) as T;
      }
      const retries: WorkflowStepContext["config"]["retries"] =
        config.retries === undefined ? { ...DEFAULT_RETRIES } : {
          limit: config.retries.limit,
          ...(typeof config.retries.delay === "function"
            ? {}
            : { delay: config.retries.delay }),
          backoff: config.retries.backoff ?? "constant",
        };
      const timeout = config.timeout ?? DEFAULT_TIMEOUT;
      for (let attempt = 1;; attempt++) {
        log.push(`run ${name} #${attempt}`);
        try {
          const result = await callback({
            step: { name, count: 1 },
            attempt,
            config: { retries: { ...retries }, timeout },
          });
          stored.set(name, structuredClone(result));
          return structuredClone(result);
        } catch (error) {
          log.push(`threw ${describe(error)}`);
          if (attempt > retries.limit) throw error;
        }
      }
    },
    sleep(name: string, duration: WorkflowDuration): Promise<void> {
      if (!slept.has(name)) {
        slept.add(name);
        log.push(`sleep ${name} ${duration}`);
      }
      return Promise.resolve();
    },
    sleepUntil(name: string, timestamp: Date | number): Promise<void> {
      if (!slept.has(name)) {
        slept.add(name);
        log.push(
          `sleepUntil ${name} ${
            typeof timestamp === "number" ? timestamp : timestamp.getTime()
          }`,
        );
      }
      return Promise.resolve();
    },
    waitForEvent<P>(
      name: string,
      _options: WorkflowWaitForEventOptions,
    ): Promise<WorkflowStepEvent<P>> {
      return Promise.reject(
        new Error(`fakeStep has no events (waitForEvent ${name})`),
      );
    },
  };
  return step as unknown as FakeStep;
}

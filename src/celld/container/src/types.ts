// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * The shapes shared by the controller, the Durable Object base class and
 * the test doubles.
 *
 * @module
 */

import type { Duration } from "./duration.ts";

/** celld's `ctx.container` (the ambient `Container` interface of celld.d.ts). */
export type NativeContainer = Container;

/** celld's `ctx.container.getTcpPort(port)`. */
export type NativeContainerPort = ContainerPort;

/**
 * What the controller believes about the container:
 *
 * - `stopped`: not running, and not wanted (never started, stopped, slept).
 * - `starting`: `start()` was called and the engine has not reported it running.
 * - `running`: the engine reports it running; required ports not yet checked.
 * - `healthy`: running, and every required port accepted a connection.
 * - `stopping`: a stop signal was sent.
 * - `failed`: it crashed more often than the restart policy allows; calls
 *   are refused until an explicit `start()`.
 */
export type ContainerStatus =
  | "stopped"
  | "starting"
  | "running"
  | "healthy"
  | "stopping"
  | "failed";

/** Why the container stopped, as `onStop` hears it. */
export type StopReason =
  | "stop"
  | "sleep"
  | "destroy"
  | "crash"
  | "start_failed";

/** What `onStop` receives. */
export interface StopEvent {
  readonly reason: StopReason;
  /** The exit status when celld reported one, else null. */
  readonly exitCode: number | null;
  /** The engine's error, for a crash or failed start. */
  readonly error?: string;
}

/** A point-in-time view of the container, as `getState()` returns it. */
export interface ContainerState {
  readonly status: ContainerStatus;
  /** The engine's live answer, not a cached one. */
  readonly running: boolean;
  /** RFC 3339 time of the last status change. */
  readonly lastChange: string;
  /** RFC 3339 time of the last activity, or null before the first. */
  readonly lastActivity: string | null;
  /** Incremented on every start; processes and setup are per generation. */
  readonly generation: number;
  /** Crash restarts inside the current restart window. */
  readonly restarts: number;
  /** The last start failure or crash, or null. */
  readonly lastError: string | null;
}

/**
 * What happens when the container is found dead while it should be running:
 *
 * - `on-demand` (default): the next call that needs it starts it again.
 * - `always`: the idle alarm also checks every `healthCheckInterval` and
 *   restarts it without waiting for a call (for long-running servers).
 * - `never`: it becomes `failed` until something calls `start()`.
 *
 * Either restarting mode gives up (status `failed`) after `maxRestarts`
 * crashes within `window`, so a crash loop stops costing starts.
 */
export type RestartMode = "never" | "on-demand" | "always";

/** See {@link RestartMode}. */
export interface RestartPolicy {
  readonly mode: RestartMode;
  readonly maxRestarts: number;
  readonly window: Duration;
}

/** Per-start overrides, as Cloudflare's `startAndWaitForPorts({...})` takes them. */
export interface StartOverrides {
  readonly envVars?: Readonly<Record<string, string>>;
  readonly entrypoint?: readonly string[];
  readonly enableInternet?: boolean;
  readonly labels?: Readonly<Record<string, string>>;
}

/** Everything a controller is configured with; every field has a default. */
export interface ContainerOptions extends StartOverrides {
  /** The port `fetch` and `containerFetch` use when none is given. */
  readonly defaultPort?: number;
  /** Ports that must accept a connection before the container counts as healthy. */
  readonly requiredPorts?: readonly number[];
  /**
   * An HTTP path to request while waiting for a port, instead of a bare
   * TCP connect (any HTTP answer counts as ready).
   */
  readonly pingPath?: string;
  /** Stop after this long without activity; default `"10m"`. */
  readonly sleepAfter?: Duration;
  /** How long `start` waits for the engine to report running; default 30 s. */
  readonly startTimeout?: Duration;
  /** How long to wait for each required port; default 30 s. */
  readonly portTimeout?: Duration;
  /** How long `stop` waits after SIGTERM before destroying; default 5 s. */
  readonly stopGrace?: Duration;
  /** How often an `always` restart policy checks; default 30 s. */
  readonly healthCheckInterval?: Duration;
  readonly restart?: Partial<RestartPolicy>;
}

/** Overridable reactions to lifecycle changes. */
export interface ContainerHooks {
  /** After a start: the engine runs it and the required ports answer. */
  onStart?(): void | Promise<void>;
  /** After it stopped, for any reason, including a detected crash. */
  onStop?(event: StopEvent): void | Promise<void>;
  /** A start failed or a crash was detected; the error is also thrown or recorded. */
  onError?(error: unknown): void | Promise<void>;
  /**
   * `sleepAfter` elapsed with no activity. Without this hook the container
   * is stopped with reason `sleep`; a hook that wants the same must call
   * `stop` itself, or `touch` to stay up.
   */
  onActivityExpired?(): void | Promise<void>;
}

/** The synchronous key/value storage the controller keeps its record in. */
export interface SyncKv {
  get<T>(key: string): T | undefined;
  put<T>(key: string, value: T): void;
  delete(key: string): boolean;
  list<T>(options?: DurableObjectListOptions): IterableIterator<[string, T]>;
}

/**
 * The part of a `DurableObjectState` the controller uses: the container,
 * the synchronous KV storage, and the single alarm.
 */
export interface ContainerHost {
  readonly container?: NativeContainer;
  readonly storage: {
    readonly kv: SyncKv;
    setAlarm(scheduledTime: number | Date): Promise<void>;
    getAlarm(): Promise<number | null>;
    deleteAlarm(): Promise<void>;
  };
}

/** Time, injectable for tests. */
export interface Clock {
  now(): number;
  sleep(ms: number): Promise<void>;
}

/** The real clock. */
export const systemClock: Clock = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

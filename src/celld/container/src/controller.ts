// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * The container lifecycle, independent of the Durable Object class around
 * it: start and readiness, crash detection and restarts, idle sleep on the
 * object's alarm, and fetches to container ports.
 *
 * {@link ContainerController} works on a {@link ContainerHost} (a
 * `DurableObjectState`, or a fake in tests) and keeps one small record in
 * the host's synchronous KV storage under `celld.container/state`. The
 * `Container` class of `@celld/container/durable` is a thin shell around it;
 * `@celld/sandbox` builds on it too.
 *
 * Two celld facts shape it. `ctx.container.monitor()` settles only within
 * the event that called it, so a crash that happens between requests is
 * noticed by the next call or alarm (the engine's `running` flag is live),
 * not by a callback. And a container outlives its object's idle eviction,
 * so idle sleep is this controller's alarm, not celld's.
 *
 * @module
 */

import { durationMs } from "./duration.ts";
import { ContainerError, messageOf } from "./errors.ts";
import {
  type Clock,
  type ContainerHooks,
  type ContainerHost,
  type ContainerOptions,
  type ContainerState,
  type ContainerStatus,
  type NativeContainer,
  type RestartMode,
  type StartOverrides,
  type StopReason,
  systemClock,
} from "./types.ts";

/** An RFC 3339 UTC time with milliseconds, as `Date#toISOString` writes it. */
function isoTime(ms: number): string {
  return new Date(ms).toISOString();
}

/** The KV key of the controller's record. */
export const STATE_KEY = "celld.container/state";

interface StateRecord {
  status: ContainerStatus;
  desired: "running" | "stopped";
  lastChange: number;
  lastActivity: number | null;
  generation: number;
  crashes: number[];
  lastError: string | null;
}

/** {@link ContainerOptions} with every default applied. */
export interface ResolvedOptions {
  readonly defaultPort: number | undefined;
  readonly requiredPorts: readonly number[];
  readonly pingPath: string | undefined;
  readonly sleepAfterMs: number;
  readonly startTimeoutMs: number;
  readonly portTimeoutMs: number;
  readonly stopGraceMs: number;
  readonly healthCheckMs: number;
  readonly restartMode: RestartMode;
  readonly maxRestarts: number;
  readonly restartWindowMs: number;
  readonly envVars: Readonly<Record<string, string>>;
  readonly entrypoint: readonly string[] | undefined;
  readonly enableInternet: boolean;
  readonly labels: Readonly<Record<string, string>>;
}

/** Checks a TCP port number; throws `ContainerError("invalid")`. */
export function checkPort(port: number): number {
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new ContainerError("invalid", `not a TCP port: ${port}`);
  }
  return port;
}

/** Applies the defaults to `options` and checks them. */
export function resolveOptions(
  options: ContainerOptions = {},
): ResolvedOptions {
  const restart = options.restart ?? {};
  const mode = restart.mode ?? "on-demand";
  if (!["never", "on-demand", "always"].includes(mode)) {
    throw new ContainerError("invalid", `unknown restart mode: ${mode}`);
  }
  const maxRestarts = restart.maxRestarts ?? 3;
  if (!Number.isInteger(maxRestarts) || maxRestarts < 0) {
    throw new ContainerError("invalid", "maxRestarts must be a whole number");
  }
  if (options.defaultPort !== undefined) checkPort(options.defaultPort);
  for (const port of options.requiredPorts ?? []) checkPort(port);
  if (options.pingPath !== undefined && !options.pingPath.startsWith("/")) {
    throw new ContainerError("invalid", "pingPath must start with /");
  }
  return {
    defaultPort: options.defaultPort,
    requiredPorts: [...(options.requiredPorts ?? [])],
    pingPath: options.pingPath,
    sleepAfterMs: durationMs(options.sleepAfter ?? "10m"),
    startTimeoutMs: durationMs(options.startTimeout ?? "30s"),
    portTimeoutMs: durationMs(options.portTimeout ?? "30s"),
    stopGraceMs: durationMs(options.stopGrace ?? "5s"),
    healthCheckMs: durationMs(options.healthCheckInterval ?? "30s"),
    restartMode: mode,
    maxRestarts,
    restartWindowMs: durationMs(restart.window ?? "10m"),
    envVars: { ...(options.envVars ?? {}) },
    entrypoint: options.entrypoint ? [...options.entrypoint] : undefined,
    // Security default: no egress unless a class or start asks for it.
    enableInternet: options.enableInternet ?? false,
    labels: { ...(options.labels ?? {}) },
  };
}

/** Options for {@link ContainerController.waitForPort}. */
export interface WaitForPortOptions {
  /** Give up after this long; default the controller's `portTimeout`. */
  readonly timeoutMs?: number;
  /** Pause between attempts; default 100 ms. */
  readonly intervalMs?: number;
  /** Request this HTTP path instead of a bare TCP connect. */
  readonly path?: string;
}

const PROBE_TIMEOUT_MS = 2_000;

// Statuses in which a container that is not running has crashed.
function isUp(status: ContainerStatus): boolean {
  return status === "running" || status === "healthy";
}

/** See the module documentation. */
export class ContainerController {
  readonly #host: ContainerHost;
  readonly #options: ResolvedOptions;
  readonly #hooks: ContainerHooks;
  readonly #clock: Clock;
  #starting: Promise<void> | null = null;
  // Set while this instance is stopping the container on purpose, so the
  // monitor does not report the exit as a crash.
  #stopping = false;
  // Operations in flight on this instance; idle sleep waits for them.
  #busy = 0;

  constructor(
    host: ContainerHost,
    options: ContainerOptions = {},
    hooks: ContainerHooks = {},
    clock: Clock = systemClock,
  ) {
    this.#host = host;
    this.#options = resolveOptions(options);
    this.#hooks = hooks;
    this.#clock = clock;
  }

  /** The options with defaults applied. */
  get options(): ResolvedOptions {
    return this.#options;
  }

  /** celld's container; throws `no_container` for a class without one. */
  get native(): NativeContainer {
    const container = this.#host.container;
    if (container === undefined) {
      throw new ContainerError(
        "no_container",
        "this Durable Object class has no container: declare it in the project's containers",
      );
    }
    return container;
  }

  /** The current start generation (0 before the first start). */
  get generation(): number {
    return this.#load().generation;
  }

  /** The recorded state, with the engine's live `running` flag. */
  state(): ContainerState {
    const record = this.#load();
    return {
      status: record.status,
      running: this.#host.container?.running ?? false,
      lastChange: isoTime(record.lastChange),
      lastActivity: record.lastActivity === null
        ? null
        : isoTime(record.lastActivity),
      generation: record.generation,
      restarts: this.#recentCrashes(record).length,
      lastError: record.lastError,
    };
  }

  /**
   * Records activity, which postpones idle sleep, and makes sure the alarm
   * that checks for it is set. Cloudflare calls this `renewActivityTimeout`.
   */
  async touch(): Promise<void> {
    const record = this.#load();
    record.lastActivity = this.#clock.now();
    this.#save(record);
    if (record.desired !== "running") return;
    if (await this.#host.storage.getAlarm() === null) {
      await this.#schedule(record);
    }
  }

  /**
   * Runs `work` as activity: idle sleep does not stop the container while
   * it runs (a long command or a log stream), and it counts as activity at
   * both ends.
   */
  async busy<T>(work: () => Promise<T>): Promise<T> {
    this.#busy += 1;
    try {
      return await work();
    } finally {
      this.#busy -= 1;
      if (this.#host.container?.running) await this.touch();
    }
  }

  /** Whether an operation started with {@link busy} is still running. */
  get isBusy(): boolean {
    return this.#busy > 0;
  }

  /**
   * Makes sure the container runs: notices a crash (and applies the restart
   * policy), starts it when it is stopped, and records activity. Every
   * operation that needs the container calls this first.
   */
  async ensureRunning(): Promise<void> {
    if (this.#starting !== null) {
      await this.#starting;
      return;
    }
    let record = this.#load();
    if (record.status === "failed") {
      throw new ContainerError(
        "failed",
        `the container crashed too often; call start() to try again (last error: ${
          record.lastError ?? "unknown"
        })`,
      );
    }
    const native = this.native;
    if (
      record.desired === "running" && isUp(record.status) && !native.running
    ) {
      await this.#crashed(record, null);
      record = this.#load();
      if (record.status === "failed") return await this.ensureRunning();
    }
    if (native.running && record.desired === "running") {
      if (record.status !== "healthy" && record.status !== "running") {
        this.#setStatus(record, "running");
      }
      await this.touch();
      return;
    }
    await this.#start(undefined, true, false);
  }

  /**
   * Starts the container if it is not running and waits for the engine to
   * report it running; with `waitForPorts` (the default) also for every
   * required port. An explicit start clears a `failed` status.
   */
  start(
    overrides?: StartOverrides,
    options: { readonly waitForPorts?: boolean } = {},
  ): Promise<void> {
    return this.#start(overrides, options.waitForPorts ?? true, true);
  }

  /**
   * Starts the container and waits for `ports` (default the required ports,
   * or the default port when there are none) to accept connections.
   */
  async startAndWaitForPorts(
    overrides?: StartOverrides,
    ports?: readonly number[],
  ): Promise<void> {
    await this.start(overrides, { waitForPorts: true });
    const wanted = ports ??
      (this.#options.requiredPorts.length > 0
        ? []
        : this.#options.defaultPort === undefined
        ? []
        : [this.#options.defaultPort]);
    for (const port of wanted) await this.waitForPort(port);
    if (wanted.length > 0) this.#setStatus(this.#load(), "healthy");
  }

  #start(
    overrides: StartOverrides | undefined,
    waitForPorts: boolean,
    explicit: boolean,
  ): Promise<void> {
    if (this.#starting !== null) return this.#starting;
    const run = this.#doStart(overrides, waitForPorts, explicit);
    this.#starting = run;
    const clear = () => {
      if (this.#starting === run) this.#starting = null;
    };
    run.then(clear, clear);
    return run;
  }

  async #doStart(
    overrides: StartOverrides | undefined,
    waitForPorts: boolean,
    explicit: boolean,
  ): Promise<void> {
    const native = this.native;
    let record = this.#load();
    if (explicit && record.status === "failed") {
      record.crashes = [];
      record.status = "stopped";
    }
    if (record.status === "failed") {
      throw new ContainerError("failed", "the container crashed too often");
    }
    if (native.running) {
      // Already up (possibly adopted after the object was reset): keep it.
      record.desired = "running";
      if (record.status !== "healthy") this.#setStatus(record, "running");
      if (waitForPorts) await this.#waitRequired();
      await this.touch();
      return;
    }
    const now = this.#clock.now();
    record = {
      ...record,
      status: "starting",
      desired: "running",
      generation: record.generation + 1,
      lastChange: now,
      lastActivity: now,
      lastError: null,
    };
    this.#save(record);
    const generation = record.generation;
    this.#stopping = false;
    const options = this.#options;
    const env = { ...options.envVars, ...(overrides?.envVars ?? {}) };
    const entrypoint = overrides?.entrypoint ?? options.entrypoint;
    let exited: { error: unknown } | null = null;
    try {
      native.start({
        env,
        enableInternet: overrides?.enableInternet ?? options.enableInternet,
        labels: { ...options.labels, ...(overrides?.labels ?? {}) },
        ...(entrypoint === undefined ? {} : { entrypoint: [...entrypoint] }),
      });
      native.monitor().then(
        () => {
          exited = { error: null };
          this.#exited(generation, null);
        },
        (error: unknown) => {
          exited = { error };
          this.#exited(generation, error);
        },
      );
    } catch (error) {
      return await this.#startFailed(error, "start_failed");
    }
    const deadline = this.#clock.now() + options.startTimeoutMs;
    while (!native.running) {
      const settled = exited as { error: unknown } | null;
      if (settled !== null) {
        return await this.#startFailed(
          settled.error ?? new Error("the container exited during start"),
          "start_failed",
        );
      }
      if (this.#clock.now() >= deadline) {
        try {
          await native.destroy();
        } catch {
          // The start already failed; this is only cleanup.
        }
        return await this.#startFailed(
          new Error(
            `the engine did not report the container running within ${options.startTimeoutMs} ms`,
          ),
          "start_timeout",
        );
      }
      await this.#clock.sleep(25);
    }
    this.#setStatus(this.#load(), "running");
    if (waitForPorts) {
      try {
        await this.#waitRequired();
      } catch (error) {
        await this.#hooks.onError?.(error);
        throw error;
      }
    }
    await this.#schedule(this.#load());
    await this.#hooks.onStart?.();
  }

  async #waitRequired(): Promise<void> {
    if (this.#options.requiredPorts.length === 0) return;
    for (const port of this.#options.requiredPorts) {
      await this.waitForPort(port, { path: this.#options.pingPath });
    }
    this.#setStatus(this.#load(), "healthy");
  }

  async #startFailed(
    error: unknown,
    code: "start_failed" | "start_timeout",
  ): Promise<never> {
    const record = this.#load();
    record.status = "stopped";
    record.desired = "stopped";
    record.lastChange = this.#clock.now();
    record.lastError = messageOf(error);
    this.#save(record);
    const failure = new ContainerError(code, messageOf(error), {
      cause: error,
    });
    await this.#hooks.onStop?.({
      reason: "start_failed",
      exitCode: null,
      error: messageOf(error),
    });
    await this.#hooks.onError?.(failure);
    throw failure;
  }

  // The monitor settled within the event that started the container.
  #exited(generation: number, error: unknown): void {
    if (this.#stopping) return;
    const record = this.#load();
    if (record.generation !== generation || record.desired !== "running") {
      return;
    }
    if (!isUp(record.status)) return; // #doStart reports a failed start.
    if (this.#host.container?.running) return;
    this.#crashed(record, error).catch(() => {
      // Hooks that throw here have nobody to report to; the record stands.
    });
  }

  #recentCrashes(record: StateRecord): number[] {
    const since = this.#clock.now() - this.#options.restartWindowMs;
    return record.crashes.filter((at) => at > since);
  }

  async #crashed(record: StateRecord, error: unknown): Promise<void> {
    const crashes = [...this.#recentCrashes(record), this.#clock.now()];
    const giveUp = this.#options.restartMode === "never" ||
      crashes.length > this.#options.maxRestarts;
    const detail = error === null || error === undefined
      ? "the container exited unexpectedly"
      : `the container exited unexpectedly: ${messageOf(error)}`;
    this.#save({
      ...record,
      status: giveUp ? "failed" : "stopped",
      desired: giveUp ? "stopped" : "running",
      crashes,
      lastChange: this.#clock.now(),
      lastError: detail,
    });
    await this.#hooks.onStop?.({
      reason: "crash",
      exitCode: null,
      error: detail,
    });
    await this.#hooks.onError?.(new ContainerError("not_running", detail));
  }

  /**
   * Waits until `port` accepts a TCP connection (or answers `path` over
   * HTTP). Throws `port_timeout`, or `not_running` if the container stops.
   */
  async waitForPort(
    port: number,
    options: WaitForPortOptions = {},
  ): Promise<void> {
    checkPort(port);
    const native = this.native;
    const timeoutMs = options.timeoutMs ?? this.#options.portTimeoutMs;
    const deadline = this.#clock.now() + timeoutMs;
    for (;;) {
      if (!native.running) {
        throw new ContainerError(
          "not_running",
          `the container stopped while waiting for port ${port}`,
        );
      }
      if (await this.#probe(native, port, options.path)) return;
      if (this.#clock.now() >= deadline) {
        throw new ContainerError(
          "port_timeout",
          `port ${port} did not accept a connection within ${timeoutMs} ms`,
        );
      }
      await this.#clock.sleep(options.intervalMs ?? 100);
    }
  }

  async #probe(
    native: NativeContainer,
    port: number,
    path: string | undefined,
  ): Promise<boolean> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<boolean>((resolve) => {
      timer = setTimeout(() => resolve(false), PROBE_TIMEOUT_MS);
    });
    const attempt = (async () => {
      try {
        if (path !== undefined) {
          const response = await native.getTcpPort(port).fetch(
            `http://container${path}`,
          );
          await response.body?.cancel();
          return true;
        }
        const socket = native.getTcpPort(port).connect();
        await socket.opened;
        await socket.close();
        return true;
      } catch {
        return false;
      }
    })();
    try {
      return await Promise.race([attempt, timeout]);
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Stops the container: `signal` (default SIGTERM), then a forced destroy
   * after the grace period. Clears the alarm and calls `onStop`.
   */
  async stop(reason: "stop" | "sleep" = "stop", signal = 15): Promise<void> {
    if (!Number.isInteger(signal) || signal < 1 || signal > 64) {
      throw new ContainerError("invalid", `not a signal number: ${signal}`);
    }
    const native = this.native;
    const record = this.#load();
    const wasUp = native.running || record.desired === "running";
    this.#stopping = true;
    this.#save({
      ...record,
      desired: "stopped",
      status: "stopping",
      lastChange: this.#clock.now(),
    });
    if (native.running) {
      try {
        native.signal(signal);
      } catch {
        // It may have exited between the check and the signal.
      }
      const deadline = this.#clock.now() + this.#options.stopGraceMs;
      while (native.running && this.#clock.now() < deadline) {
        await this.#clock.sleep(50);
      }
      if (native.running) await native.destroy();
    }
    await this.#finishStop(reason, wasUp);
  }

  /** Stops the container at once (SIGKILL) and calls `onStop` with `destroy`. */
  async destroy(): Promise<void> {
    const native = this.native;
    const record = this.#load();
    const wasUp = native.running || record.desired === "running";
    this.#stopping = true;
    this.#save({ ...record, desired: "stopped", status: "stopping" });
    await native.destroy();
    await this.#finishStop("destroy", wasUp);
  }

  async #finishStop(reason: StopReason, wasUp: boolean): Promise<void> {
    const record = this.#load();
    this.#setStatus(record, "stopped");
    await this.#host.storage.deleteAlarm();
    if (wasUp) await this.#hooks.onStop?.({ reason, exitCode: null });
  }

  /** The route to `port` (default `defaultPort`), starting the container first. */
  async tcpPort(port?: number): Promise<ContainerPort> {
    const target = port ?? this.#options.defaultPort;
    if (target === undefined) {
      throw new ContainerError(
        "invalid",
        "no port given and the container has no defaultPort",
      );
    }
    checkPort(target);
    await this.ensureRunning();
    return this.native.getTcpPort(target);
  }

  /**
   * An HTTP request to a container port (default `defaultPort`): starts the
   * container if needed and counts as activity. Cloudflare's `containerFetch`.
   */
  async fetch(
    input: Request | string | URL,
    init?: RequestInit,
    port?: number,
  ): Promise<Response> {
    const route = await this.tcpPort(port);
    const request = input instanceof Request
      ? (init === undefined ? input : new Request(input, init))
      : new Request(input, init);
    return await route.fetch(request);
  }

  /**
   * The Durable Object's `alarm()`: notices crashes (restarting under the
   * `always` policy), sleeps the container after `sleepAfter` of no
   * activity, and schedules the next check.
   */
  async alarm(): Promise<void> {
    const native = this.#host.container;
    if (native === undefined) return;
    let record = this.#load();
    if (record.desired !== "running" || this.#starting !== null) return;
    if (!native.running) {
      if (isUp(record.status)) await this.#crashed(record, null);
      record = this.#load();
      if (
        this.#options.restartMode !== "always" || record.status === "failed"
      ) {
        return;
      }
      try {
        await this.#start(undefined, true, false);
      } catch {
        // Recorded in the state and reported to onError already.
      }
      return;
    }
    const now = this.#clock.now();
    if (this.#busy > 0) {
      record.lastActivity = now;
      this.#save(record);
    }
    const idle = now - (record.lastActivity ?? record.lastChange);
    if (idle >= this.#options.sleepAfterMs) {
      if (this.#hooks.onActivityExpired) {
        await this.#hooks.onActivityExpired();
      } else {
        await this.stop("sleep");
      }
      record = this.#load();
      if (record.desired !== "running") return;
    }
    await this.#schedule(record);
  }

  async #schedule(record: StateRecord): Promise<void> {
    const now = this.#clock.now();
    let at = (record.lastActivity ?? now) + this.#options.sleepAfterMs;
    if (this.#options.restartMode === "always") {
      at = Math.min(at, now + this.#options.healthCheckMs);
    }
    await this.#host.storage.setAlarm(Math.max(at, now + 1));
  }

  #setStatus(record: StateRecord, status: ContainerStatus): void {
    if (record.status === status) return;
    this.#save({ ...record, status, lastChange: this.#clock.now() });
  }

  #load(): StateRecord {
    return this.#host.storage.kv.get<StateRecord>(STATE_KEY) ?? {
      status: "stopped",
      desired: "stopped",
      lastChange: this.#clock.now(),
      lastActivity: null,
      generation: 0,
      crashes: [],
      lastError: null,
    };
  }

  #save(record: StateRecord): void {
    this.#host.storage.kv.put(STATE_KEY, record);
  }
}

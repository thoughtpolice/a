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
 * `Container` class of `@celld/box/container/durable` is a thin shell around it;
 * `@celld/box/sandbox` builds on it too.
 *
 * Two celld facts shape it. `ctx.container.monitor()` settles only within
 * the event that called it, so a crash that happens between requests is
 * noticed by the next call or alarm (the engine's `running` flag is live),
 * not by a callback. And a container outlives its object's idle eviction,
 * so idle sleep is this controller's alarm, not celld's.
 *
 * @module
 */

import { jsonSnapshot, safeInt, strictRecord } from "@celld/core/bounds";
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

/**
 * The operational ranges of the timing and count options, in ms (or a
 * count). Each is checked after the duration is converted, so no setting
 * can be `Infinity`, past a timer's range, or long enough to wedge the
 * object (a start that waits a day).
 */
export const OPTION_LIMITS = jsonSnapshot(
  {
    /** `sleepAfter`: up to 7 days. */
    sleepAfterMs: { min: 0, max: 7 * 86_400_000 },
    /** `startTimeout`: 1 ms to 10 minutes. */
    startTimeoutMs: { min: 1, max: 600_000 },
    /** `portTimeout` (and `waitForPort`'s `timeoutMs`): up to 10 minutes. */
    portTimeoutMs: { min: 0, max: 600_000 },
    /** `stopGrace`: up to 5 minutes. */
    stopGraceMs: { min: 0, max: 300_000 },
    /** `healthCheckInterval`: 1 s to 1 day. */
    healthCheckMs: { min: 1_000, max: 86_400_000 },
    /** `restart.window`: up to 7 days. */
    restartWindowMs: { min: 0, max: 7 * 86_400_000 },
    /** `restart.maxRestarts`: 0 to 1,000. */
    maxRestarts: { min: 0, max: 1_000 },
    /** `requiredPorts`: at most 64 ports. */
    requiredPorts: { min: 0, max: 64 },
    /** `waitForPort`'s `intervalMs`: 1 ms to 1 minute. */
    intervalMs: { min: 1, max: 60_000 },
  } as const,
);

// Runs a check from @celld/core/bounds or durationMs and reports its refusal
// as `invalid`, the code every option error has.
function checked<T>(check: () => T): T {
  try {
    return check();
  } catch (error) {
    if (error instanceof RangeError || error instanceof TypeError) {
      throw new ContainerError("invalid", error.message, { cause: error });
    }
    throw error;
  }
}

function known(value: unknown, keys: readonly string[], name: string): void {
  checked(() => strictRecord(value, keys, name));
}

function path(value: unknown, name: string): void {
  if (
    value !== undefined &&
    (typeof value !== "string" || value.length > 4096 ||
      !value.startsWith("/") || value.startsWith("//") ||
      // deno-lint-ignore no-control-regex -- HTTP paths cannot contain controls.
      /[\\\s#\x00-\x1f\x7f]/.test(value))
  ) {
    throw new ContainerError(
      "invalid",
      `${name} must be a bounded absolute HTTP path`,
    );
  }
}

function startOptions(options: StartOverrides): void {
  if (
    options.enableInternet !== undefined &&
    typeof options.enableInternet !== "boolean"
  ) throw new ContainerError("invalid", "enableInternet must be boolean");
  for (const field of ["envVars", "labels"] as const) {
    const record = options[field];
    if (record === undefined) continue;
    if (
      record === null || typeof record !== "object" || Array.isArray(record)
    ) throw new ContainerError("invalid", `${field} must be a plain record`);
    known(record, Object.keys(record), field);
    if (Object.keys(record).length > 256) {
      throw new ContainerError("invalid", `${field} has too many entries`);
    }
    for (const [key, value] of Object.entries(record)) {
      if (
        key.length === 0 || key.length > 256 ||
        (field === "envVars" && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) ||
        typeof value !== "string" || value.length > 16384 ||
        key.includes("\0") || value.includes("\0")
      ) {
        throw new ContainerError(
          "invalid",
          `${field} must contain bounded valid string entries`,
        );
      }
    }
  }
  const command = options.entrypoint;
  if (
    command !== undefined &&
    (!Array.isArray(command) || command.length === 0 || command.length > 256 ||
      command.some((part) =>
        typeof part !== "string" || part.length > 16384 || part.includes("\0")
      ) || command[0] === "")
  ) {
    throw new ContainerError(
      "invalid",
      "entrypoint must be a bounded nonempty argument list",
    );
  }
}

function duration(
  value: string | undefined,
  fallback: string,
  name: keyof typeof OPTION_LIMITS,
  label: string,
): number {
  return checked(() =>
    durationMs(value ?? fallback, { name: label, ...OPTION_LIMITS[name] })
  );
}

/** Applies the defaults to `options` and checks them. */
export function resolveOptions(
  options: ContainerOptions = {},
): ResolvedOptions {
  known(options, [
    "defaultPort",
    "requiredPorts",
    "pingPath",
    "sleepAfter",
    "startTimeout",
    "portTimeout",
    "stopGrace",
    "healthCheckInterval",
    "restart",
    "envVars",
    "entrypoint",
    "enableInternet",
    "labels",
  ], "container options");
  startOptions(options);
  const restart = options.restart ?? {};
  known(restart, ["mode", "maxRestarts", "window"], "restart options");
  const mode = restart.mode ?? "on-demand";
  if (!["never", "on-demand", "always"].includes(mode)) {
    throw new ContainerError("invalid", `unknown restart mode: ${mode}`);
  }
  const maxRestarts = checked(() =>
    safeInt(restart.maxRestarts ?? 3, {
      name: "maxRestarts",
      ...OPTION_LIMITS.maxRestarts,
    })
  );
  if (options.defaultPort !== undefined) checkPort(options.defaultPort);
  const required = options.requiredPorts ?? [];
  if (
    !Array.isArray(required) ||
    required.length > OPTION_LIMITS.requiredPorts.max
  ) {
    throw new ContainerError(
      "invalid",
      `requiredPorts must be a list of at most ${OPTION_LIMITS.requiredPorts.max} ports`,
    );
  }
  for (const port of required) checkPort(port);
  path(options.pingPath, "pingPath");
  return Object.freeze({
    defaultPort: options.defaultPort,
    requiredPorts: Object.freeze([...required]),
    pingPath: options.pingPath,
    sleepAfterMs: duration(
      options.sleepAfter,
      "10m",
      "sleepAfterMs",
      "sleepAfter",
    ),
    startTimeoutMs: duration(
      options.startTimeout,
      "30s",
      "startTimeoutMs",
      "startTimeout",
    ),
    portTimeoutMs: duration(
      options.portTimeout,
      "30s",
      "portTimeoutMs",
      "portTimeout",
    ),
    stopGraceMs: duration(options.stopGrace, "5s", "stopGraceMs", "stopGrace"),
    healthCheckMs: duration(
      options.healthCheckInterval,
      "30s",
      "healthCheckMs",
      "healthCheckInterval",
    ),
    restartMode: mode,
    maxRestarts,
    restartWindowMs: duration(
      restart.window,
      "10m",
      "restartWindowMs",
      "restart.window",
    ),
    envVars: Object.freeze({ ...(options.envVars ?? {}) }),
    entrypoint: options.entrypoint
      ? Object.freeze([...options.entrypoint])
      : undefined,
    // Security default: no egress unless a class or start asks for it.
    enableInternet: options.enableInternet ?? false,
    labels: Object.freeze({ ...(options.labels ?? {}) }),
  });
}

/** Options for {@link ContainerController.waitForPort}. */
export interface WaitForPortOptions {
  /**
   * Give up after this long, in ms; default the controller's
   * `portTimeout`, at most 10 minutes.
   */
  readonly timeoutMs?: number;
  /** Pause between attempts, in ms; default 100, 1 to 60,000. */
  readonly intervalMs?: number;
  /** Request this HTTP path instead of a bare TCP connect. */
  readonly path?: string;
}

const PROBE_TIMEOUT_MS = 2_000;

// Statuses in which a container that is not running has crashed.
function isUp(status: ContainerStatus): boolean {
  return status === "running" || status === "healthy" ||
    status === "unhealthy";
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
  // Other users of the object's single alarm; see addWakeSource.
  readonly #wakeSources: (() => number | null)[] = [];

  constructor(
    host: ContainerHost,
    options: ContainerOptions = {},
    hooks: ContainerHooks = {},
    clock: Clock = systemClock,
  ) {
    this.#host = host;
    this.#options = resolveOptions(options);
    known(
      hooks,
      ["onStart", "onStop", "onError", "onActivityExpired"],
      "container hooks",
    );
    for (const hook of Object.values(hooks)) {
      if (hook !== undefined && typeof hook !== "function") {
        throw new ContainerError(
          "invalid",
          "container hooks must be functions",
        );
      }
    }
    this.#hooks = Object.freeze({ ...hooks });
    if (typeof clock.now !== "function" || typeof clock.sleep !== "function") {
      throw new ContainerError("invalid", "clock must provide now and sleep");
    }
    const now = clock.now.bind(clock);
    this.#clock = Object.freeze({
      now: () =>
        checked(() =>
          safeInt(now(), { min: 0, max: 8.64e15, name: "clock.now" })
        ),
      sleep: clock.sleep.bind(clock),
    });
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
    const current = await this.#host.storage.getAlarm();
    if (current === null || current > this.#idleCheckAt(record)) {
      await this.#schedule(record);
    }
  }

  /**
   * Registers another user of the Durable Object's single alarm: `source`
   * answers the earliest time it needs the alarm (or null). Whenever the
   * controller sets or clears the alarm it keeps the earliest of its own
   * time and every source's, so stopping the container does not cancel,
   * say, a purge of expired records. The object's `alarm()` must then
   * dispatch to both (see `Container.alarm`).
   */
  addWakeSource(source: () => number | null): void {
    this.#wakeSources.push(source);
  }

  /** Makes sure the alarm fires no later than `at` (Unix milliseconds). */
  async wakeBy(at: number): Promise<void> {
    if (!Number.isFinite(at)) {
      throw new ContainerError("invalid", `not a time: ${at}`);
    }
    const current = await this.#host.storage.getAlarm();
    if (current === null || current > at) {
      await this.#host.storage.setAlarm(Math.max(at, this.#clock.now() + 1));
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
    // Each pass looks at the state afresh: a start, a restart or a probe
    // that another caller began is awaited, and then the checks run again,
    // so a start that skipped the port wait is never served unprobed.
    for (;;) {
      if (this.#starting !== null) {
        await this.#starting;
        continue;
      }
      const record = this.#load();
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
        continue;
      }
      if (native.running && record.desired === "running") {
        if (
          record.status !== "healthy" && record.status !== "running" &&
          record.status !== "unhealthy"
        ) {
          this.#setStatus(record, "running");
        }
        // Readiness is checked before serving: a container whose required
        // ports did not answer (or were never waited for) is probed again,
        // and refused with `unhealthy` while they still do not answer.
        if (
          this.#options.requiredPorts.length > 0 &&
          this.#load().status !== "healthy"
        ) {
          await this.#recheck();
          continue;
        }
        await this.touch();
        return;
      }
      await this.#start(undefined, true, false);
    }
  }

  // Probes the required ports of a running container once more (shared
  // by concurrent callers, like a start). Healthy on success; otherwise
  // `unhealthy`, with the retry alarm set, and `unhealthy` is thrown.
  #recheck(): Promise<void> {
    if (this.#options.requiredPorts.length === 0) {
      this.#setStatus(this.#load(), "running");
      return Promise.resolve();
    }
    // A start in flight may skip the port wait: probe after it.
    const before = this.#starting;
    if (before !== null) return before.then(() => this.#recheck());
    const run = (async () => {
      try {
        await this.#waitRequired();
      } catch (error) {
        const known = ContainerError.from(error);
        if (known?.code !== "port_timeout") throw error;
        await this.#markUnhealthy(known);
        throw new ContainerError(
          "unhealthy",
          `the container runs but is not served: ${known.detail}`,
          { cause: error },
        );
      }
    })();
    this.#starting = run;
    const clear = () => {
      if (this.#starting === run) this.#starting = null;
    };
    run.then(clear, clear);
    return run;
  }

  // Required ports did not answer: keep the container, stop serving it,
  // and make sure the alarm comes back to retry (and to sleep it if idle).
  async #markUnhealthy(error: ContainerError): Promise<void> {
    const record = this.#load();
    this.#save({
      ...record,
      status: "unhealthy",
      lastChange: record.status === "unhealthy"
        ? record.lastChange
        : this.#clock.now(),
      lastError: error.detail,
    });
    await this.#schedule(this.#load());
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
    known(options, ["waitForPorts"], "start options");
    if (
      options.waitForPorts !== undefined &&
      typeof options.waitForPorts !== "boolean"
    ) throw new ContainerError("invalid", "waitForPorts must be boolean");
    if (overrides !== undefined) {
      known(
        overrides,
        ["envVars", "entrypoint", "enableInternet", "labels"],
        "start overrides",
      );
      startOptions(overrides);
      overrides = Object.freeze({
        ...overrides,
        ...(overrides.envVars === undefined
          ? {}
          : { envVars: Object.freeze({ ...overrides.envVars }) }),
        ...(overrides.labels === undefined
          ? {}
          : { labels: Object.freeze({ ...overrides.labels }) }),
        ...(overrides.entrypoint === undefined
          ? {}
          : { entrypoint: Object.freeze([...overrides.entrypoint]) }),
      });
    }
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
    if (ports !== undefined) {
      if (!Array.isArray(ports) || ports.length > 64) {
        throw new ContainerError("invalid", "ports must be a bounded array");
      }
      for (const port of ports) checkPort(port);
      ports = [...ports];
    }
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
      if (record.status !== "healthy" && record.status !== "unhealthy") {
        this.#setStatus(record, "running");
      } else {
        this.#save(record);
      }
      try {
        if (waitForPorts) await this.#waitRequired();
      } catch (error) {
        const known = ContainerError.from(error);
        if (known?.code === "port_timeout") await this.#markUnhealthy(known);
        throw error;
      }
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
        // The container runs but is not ready: `unhealthy`, never served
        // until its ports answer, and the alarm is set either way so it
        // is retried and slept when idle.
        const known = ContainerError.from(error);
        if (known?.code === "port_timeout") {
          await this.#markUnhealthy(known);
        } else {
          await this.#schedule(this.#load());
        }
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
    known(options, ["timeoutMs", "intervalMs", "path"], "waitForPort options");
    path(options.path, "waitForPort path");
    checkPort(port);
    const timeoutMs = options.timeoutMs === undefined
      ? this.#options.portTimeoutMs
      : checked(() =>
        safeInt(options.timeoutMs, {
          name: "timeoutMs",
          ...OPTION_LIMITS.portTimeoutMs,
        })
      );
    const intervalMs = options.intervalMs === undefined
      ? 100
      : checked(() =>
        safeInt(options.intervalMs, {
          name: "intervalMs",
          ...OPTION_LIMITS.intervalMs,
        })
      );
    const native = this.native;
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
      await this.#clock.sleep(intervalMs);
    }
  }

  // One connection attempt, bounded by PROBE_TIMEOUT_MS. The attempt is
  // ended, not just outraced, when the time runs out: the request is
  // aborted and the socket closed, so retries never pile up connections.
  async #probe(
    native: NativeContainer,
    port: number,
    path: string | undefined,
  ): Promise<boolean> {
    const stop = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<boolean>((resolve) => {
      timer = setTimeout(() => {
        stop.abort(new Error("the probe timed out"));
        resolve(false);
      }, PROBE_TIMEOUT_MS);
    });
    const attempt = (async () => {
      try {
        if (path !== undefined) {
          const response = await native.getTcpPort(port).fetch(
            `http://container${path}`,
            { signal: stop.signal },
          );
          await response.body?.cancel();
          return true;
        }
        const socket = native.getTcpPort(port).connect();
        const close = () => {
          socket.close().catch(() => {});
        };
        stop.signal.addEventListener("abort", close, { once: true });
        try {
          await socket.opened;
        } finally {
          stop.signal.removeEventListener("abort", close);
        }
        await socket.close();
        return !stop.signal.aborted;
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
   * after the grace period. Clears the idle alarm (a wake source's time
   * stays) and calls `onStop`.
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
    await this.#arm(null);
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
    let record = this.#load();
    if (
      native === undefined || record.desired !== "running" ||
      this.#starting !== null
    ) {
      // Nothing to check for the container; other users may still need it.
      await this.#arm(null);
      return;
    }
    if (!native.running) {
      if (isUp(record.status)) await this.#crashed(record, null);
      record = this.#load();
      if (
        this.#options.restartMode !== "always" || record.status === "failed"
      ) {
        await this.#arm(null);
        return;
      }
      try {
        await this.#start(undefined, true, false);
      } catch {
        // Recorded in the state and reported to onError already.
      }
      // The next check follows the state the restart left: the health
      // check of a running container, the readiness retry of an unhealthy
      // one, or nothing once a failed start gave up on it.
      record = this.#load();
      if (record.desired === "running") await this.#schedule(record);
      else await this.#arm(null);
      return;
    }
    const now = this.#clock.now();
    if (this.#busy > 0) {
      record.lastActivity = now;
      this.#save(record);
    }
    const idle = now - (record.lastActivity ?? record.lastChange);
    if (
      record.status === "unhealthy" && idle < this.#options.sleepAfterMs
    ) {
      // The scheduled retry of a container whose required ports did not
      // answer; a failure keeps it unhealthy and schedules the next one.
      try {
        await this.#recheck();
      } catch {
        // Recorded in the state.
      }
      record = this.#load();
    }
    if (idle >= this.#options.sleepAfterMs) {
      if (this.#hooks.onActivityExpired) {
        await this.#hooks.onActivityExpired();
      } else {
        await this.stop("sleep");
      }
      record = this.#load();
      if (record.desired !== "running") {
        await this.#arm(null);
        return;
      }
    }
    await this.#schedule(record);
  }

  // When the idle (and health) check for `record` is due; an unhealthy
  // container is retried at the health check interval.
  #idleCheckAt(record: StateRecord): number {
    const now = this.#clock.now();
    let at = (record.lastActivity ?? now) + this.#options.sleepAfterMs;
    if (
      this.#options.restartMode === "always" || record.status === "unhealthy"
    ) {
      at = Math.min(at, now + this.#options.healthCheckMs);
    }
    return at;
  }

  async #schedule(record: StateRecord): Promise<void> {
    await this.#arm(this.#idleCheckAt(record));
  }

  // Sets the alarm to the earliest of `at` (the controller's own, or null)
  // and every wake source's time, or clears it when there is none.
  async #arm(at: number | null): Promise<void> {
    let earliest = at;
    for (const source of this.#wakeSources) {
      const wake = source();
      if (wake !== null && (earliest === null || wake < earliest)) {
        earliest = wake;
      }
    }
    if (earliest === null) {
      await this.#host.storage.deleteAlarm();
    } else {
      await this.#host.storage.setAlarm(
        Math.max(earliest, this.#clock.now() + 1),
      );
    }
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

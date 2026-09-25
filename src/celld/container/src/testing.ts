// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * Test doubles for code built on `@celld/container`, with no container
 * engine:
 *
 * - {@link FakeContainer}: celld's `ctx.container`. `exec` runs real host
 *   processes with `Deno.Command` by default (so shell scripts meant for the
 *   container really run, in a temporary directory), or answers from an
 *   {@link ExecHandler} you script. Starts, crashes, signals and ports are
 *   under the test's control.
 * - {@link FakeState}: the `DurableObjectState` subset the controller
 *   needs: a structured-clone KV map and one alarm.
 * - {@link ManualClock}: time that moves only when told to.
 *
 * The process-backed exec needs `--allow-run` (and usually `--allow-read`,
 * `--allow-write` and `--allow-env`). It runs as the test's user, ignores
 * the `user` option, and is no sandbox: only give it trusted commands.
 *
 * @module
 */

import type { Clock, ContainerHost, SyncKv } from "./types.ts";

/** What a scripted exec answers. */
export interface ScriptedExec {
  readonly stdout?: string | Uint8Array;
  readonly stderr?: string | Uint8Array;
  readonly exitCode?: number;
  /** Wait this long before finishing (a kill ends it early with 137). */
  readonly delayMs?: number;
}

/** One exec call as a scripted handler sees it. */
export interface ExecCall {
  readonly argv: readonly string[];
  readonly options: ContainerExecOptions;
  /** Everything written to stdin, when stdin was given. */
  readonly stdin: Uint8Array | null;
}

/** Answers exec calls in scripted mode; return null to run the real process. */
export type ExecHandler = (
  call: ExecCall,
) => ScriptedExec | null | Promise<ScriptedExec | null>;

/** Answers HTTP requests to one fake container port. */
export type PortHandler = (request: Request) => Response | Promise<Response>;

/** Options for {@link FakeContainer}. */
export interface FakeContainerOptions {
  /** Scripted exec; without it every exec runs a host process. */
  readonly exec?: ExecHandler;
  /** Working directory for exec calls without `cwd`; default the test's. */
  readonly cwd?: string;
  /** The container's environment, which exec inherits; default only PATH. */
  readonly env?: Record<string, string>;
  /** Report running only after this many `running` reads; default 0. */
  readonly startDelayReads?: number;
}

const SIGNALS: Record<number, Deno.Signal> = {
  1: "SIGHUP",
  2: "SIGINT",
  3: "SIGQUIT",
  9: "SIGKILL",
  10: "SIGUSR1",
  12: "SIGUSR2",
  15: "SIGTERM",
};

const encoder = new TextEncoder();

function bytesOf(value: string | Uint8Array | undefined): Uint8Array {
  if (value === undefined) return new Uint8Array();
  return typeof value === "string" ? encoder.encode(value) : value;
}

async function collect(
  stream: ReadableStream<Uint8Array> | null,
): Promise<ArrayBuffer> {
  if (stream === null) return new ArrayBuffer(0);
  const buffer = await new Response(stream).arrayBuffer();
  return buffer;
}

async function readInput(
  stdin: ContainerExecOptions["stdin"],
): Promise<Uint8Array | null> {
  if (stdin === undefined || stdin === "pipe") return null;
  const chunks: Uint8Array[] = [];
  const reader = stdin.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(
      value instanceof Uint8Array
        ? value
        : ArrayBuffer.isView(value)
        ? new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
        : new Uint8Array(value),
    );
  }
  const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  const all = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    all.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return all;
}

// Interleaves two byte streams as their chunks arrive.
function merge(
  a: ReadableStream<Uint8Array>,
  b: ReadableStream<Uint8Array>,
): ReadableStream<Uint8Array> {
  const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
  const writer = writable.getWriter();
  const pump = async (stream: ReadableStream<Uint8Array>) => {
    const reader = stream.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      await writer.write(value);
    }
  };
  Promise.all([pump(a), pump(b)]).then(
    () => writer.close(),
    (error) => writer.abort(error),
  );
  return readable;
}

class FakeProcess implements ContainerExecProcess {
  constructor(
    readonly pid: number,
    readonly stdin: WritableStream<ArrayBuffer | ArrayBufferView> | null,
    readonly stdout: ReadableStream<Uint8Array> | null,
    readonly stderr: ReadableStream<Uint8Array> | null,
    readonly exitCode: Promise<number>,
    readonly kill: (signal?: number) => void,
  ) {}

  async output(): Promise<ContainerExecOutput> {
    const [stdout, stderr, exitCode] = await Promise.all([
      collect(this.stdout),
      collect(this.stderr),
      this.exitCode,
    ]);
    return { stdout, stderr, exitCode };
  }
}

/** See the module documentation. */
export class FakeContainer implements Container {
  /** Every `start` call's options, in order. */
  readonly starts: ContainerStartOptions[] = [];
  /** Every signal sent to the container itself. */
  readonly signals: number[] = [];
  /** Every exec call's argv and options, in order. */
  readonly execs: { argv: string[]; options: ContainerExecOptions }[] = [];
  /** How often `destroy` was called. */
  destroys = 0;
  /** Inactivity timeouts set, in order. */
  readonly inactivityTimeouts: number[] = [];
  /** Handlers for `getTcpPort(port)`; ports without one refuse connections. */
  readonly ports = new Map<number, PortHandler>();

  #running = false;
  #delay = 0;
  #pending = 0;
  #failNextStart: Error | null = null;
  #monitors: {
    resolve: () => void;
    reject: (error: unknown) => void;
  }[] = [];
  #processes = new Set<(signal?: number) => void>();
  #nextPid = 100;
  readonly #options: FakeContainerOptions;

  constructor(options: FakeContainerOptions = {}) {
    this.#options = options;
    this.#delay = options.startDelayReads ?? 0;
  }

  get running(): boolean {
    if (this.#pending > 0) {
      this.#pending -= 1;
      if (this.#pending === 0) this.#running = true;
    }
    return this.#running;
  }

  /** Makes the next `start` report this failure through `monitor()`. */
  failNextStart(error: Error): void {
    this.#failNextStart = error;
  }

  start(options: ContainerStartOptions = {}): void {
    if (this.#running) throw new Error("the container is already running");
    this.starts.push(structuredClone(options));
    const failure = this.#failNextStart;
    if (failure !== null) {
      this.#failNextStart = null;
      queueMicrotask(() => this.#settle(failure));
      return;
    }
    if (this.#delay > 0) {
      this.#pending = this.#delay;
    } else {
      this.#running = true;
    }
  }

  monitor(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.#monitors.push({ resolve, reject });
    });
  }

  /** The container's main process exits (a crash when `exitCode` is not 0). */
  crash(exitCode = 1): void {
    this.#running = false;
    this.#pending = 0;
    this.#killAll();
    this.#settle(
      exitCode === 0
        ? null
        : new Error(`container exited with status ${exitCode}`),
    );
  }

  #settle(error: Error | null): void {
    const monitors = this.#monitors;
    this.#monitors = [];
    for (const monitor of monitors) {
      if (error === null) monitor.resolve();
      else monitor.reject(error);
    }
  }

  #killAll(): void {
    for (const kill of this.#processes) kill(9);
    this.#processes.clear();
  }

  destroy(error?: unknown): Promise<void> {
    this.destroys += 1;
    const wasRunning = this.#running;
    this.#running = false;
    this.#pending = 0;
    this.#killAll();
    if (wasRunning) {
      this.#settle(
        error === undefined ? new Error("the container was destroyed") : (
          error instanceof Error ? error : new Error(String(error))
        ),
      );
    }
    return Promise.resolve();
  }

  signal(signal: number): void {
    if (!this.#running) throw new Error("the container is not running");
    this.signals.push(signal);
    if (signal === 9 || signal === 15 || signal === 2) {
      this.#running = false;
      this.#killAll();
      this.#settle(null);
    }
  }

  getTcpPort(port: number): ContainerPort {
    const handler = () => {
      const found = this.#running ? this.ports.get(port) : undefined;
      if (found === undefined) {
        throw new Error(`The container is not listening on port ${port}`);
      }
      return found;
    };
    const fetch = async (
      input: RequestInfo | URL,
      init?: RequestInit,
    ): Promise<Response> => await handler()(new Request(input, init));
    const connect = (): Socket => {
      let ok = true;
      try {
        handler();
      } catch {
        ok = false;
      }
      const opened = ok
        ? Promise.resolve({ remoteAddress: `container:${port}` } as SocketInfo)
        : Promise.reject(new Error(`connection refused on port ${port}`));
      opened.catch(() => {});
      const closed = opened.then(() => undefined);
      closed.catch(() => {});
      return {
        readable: new ReadableStream(),
        writable: new WritableStream(),
        opened,
        closed,
        secureTransport: "off",
        close: () => Promise.resolve(),
        startTls: () => {
          throw new Error("not supported by the fake");
        },
      } as Socket;
    };
    return { fetch, connect } as unknown as ContainerPort;
  }

  setInactivityTimeout(durationMs: number): Promise<string> {
    this.inactivityTimeouts.push(durationMs);
    return Promise.resolve("");
  }

  async exec(
    command: string[],
    options: ContainerExecOptions = {},
  ): Promise<ContainerExecProcess> {
    if (!this.#running) {
      throw new Error(
        "exec() cannot be called on a container that is not running.",
      );
    }
    if (command.length === 0) {
      throw new Error("exec() needs a nonempty command");
    }
    if (options.stderr === "combined" && options.stdout === "ignore") {
      throw new Error('stderr: "combined" requires a piped stdout');
    }
    this.execs.push({ argv: [...command], options: { ...options } });
    const scripted = this.#options.exec;
    if (scripted !== undefined) {
      const stdin = await readInput(options.stdin);
      const answer = await scripted({ argv: [...command], options, stdin });
      if (answer !== null) return this.#scripted(answer, options);
      return this.#spawn(command, options, stdin);
    }
    return this.#spawn(command, options, null);
  }

  #scripted(answer: ScriptedExec, options: ContainerExecOptions): FakeProcess {
    const pid = this.#nextPid++;
    let finish: (code: number) => void = () => {};
    const exitCode = new Promise<number>((resolve) => {
      finish = resolve;
    });
    let timer: ReturnType<typeof setTimeout> | undefined;
    const kill = (signal = 15) => {
      clearTimeout(timer);
      this.#processes.delete(kill);
      finish(128 + signal);
    };
    this.#processes.add(kill);
    if (answer.delayMs) {
      timer = setTimeout(() => {
        this.#processes.delete(kill);
        finish(answer.exitCode ?? 0);
      }, answer.delayMs);
    } else {
      this.#processes.delete(kill);
      finish(answer.exitCode ?? 0);
    }
    const out = bytesOf(answer.stdout);
    const err = bytesOf(answer.stderr);
    const stream = (bytes: Uint8Array) =>
      new ReadableStream<Uint8Array>({
        async start(controller) {
          await exitCode;
          if (bytes.byteLength > 0) controller.enqueue(bytes);
          controller.close();
        },
      });
    let stdout: ReadableStream<Uint8Array> | null = options.stdout === "ignore"
      ? null
      : stream(out);
    let stderr: ReadableStream<Uint8Array> | null = options.stderr === "ignore"
      ? null
      : stream(err);
    if (options.stderr === "combined" && stdout !== null) {
      stdout = stream(new Uint8Array([...out, ...err]));
      stderr = null;
    }
    const stdin = options.stdin === "pipe" ? new WritableStream() : null;
    return new FakeProcess(pid, stdin, stdout, stderr, exitCode, kill);
  }

  #spawn(
    command: string[],
    options: ContainerExecOptions,
    given: Uint8Array | null,
  ): FakeProcess {
    const stdinMode = options.stdin === undefined ? "null" : "piped";
    const child = new Deno.Command(command[0], {
      args: command.slice(1),
      cwd: options.cwd ?? this.#options.cwd,
      clearEnv: true,
      env: {
        PATH: Deno.env.get("PATH") ?? "/usr/bin:/bin",
        ...(this.#options.env ?? {}),
        ...(options.env ?? {}),
      },
      stdin: stdinMode,
      stdout: options.stdout === "ignore" ? "null" : "piped",
      stderr: options.stderr === "ignore" ? "null" : "piped",
    }).spawn();
    let exited = false;
    const kill = (signal = 15) => {
      if (exited) return;
      try {
        child.kill(SIGNALS[signal] ?? "SIGTERM");
      } catch {
        // Already gone.
      }
    };
    this.#processes.add(kill);
    const exitCode = child.status.then((status) => {
      exited = true;
      this.#processes.delete(kill);
      if (status.signal === null) return status.code;
      const number = Object.entries(SIGNALS).find(([, name]) =>
        name === status.signal
      )?.[0];
      return 128 + (number === undefined ? 9 : Number(number));
    });
    let stdin: WritableStream<ArrayBuffer | ArrayBufferView> | null = null;
    if (options.stdin === "pipe") {
      stdin = child.stdin as unknown as WritableStream<
        ArrayBuffer | ArrayBufferView
      >;
    } else if (options.stdin !== undefined) {
      const input = given === null ? options.stdin : new Blob([
        given as Uint8Array<ArrayBuffer>,
      ]).stream();
      (input as ReadableStream<Uint8Array>).pipeTo(child.stdin).catch(() => {});
    }
    let stdout: ReadableStream<Uint8Array> | null = options.stdout === "ignore"
      ? null
      : child.stdout;
    let stderr: ReadableStream<Uint8Array> | null = options.stderr === "ignore"
      ? null
      : child.stderr;
    if (options.stderr === "combined" && stdout !== null && stderr !== null) {
      stdout = merge(stdout, stderr);
      stderr = null;
    }
    return new FakeProcess(child.pid, stdin, stdout, stderr, exitCode, kill);
  }
}

/** A structured-clone key/value map with the synchronous KV interface. */
export class FakeKv implements SyncKv {
  readonly map = new Map<string, unknown>();

  get<T>(key: string): T | undefined {
    const value = this.map.get(key);
    return value === undefined ? undefined : structuredClone(value) as T;
  }

  put<T>(key: string, value: T): void {
    this.map.set(key, structuredClone(value));
  }

  delete(key: string): boolean {
    return this.map.delete(key);
  }

  *list<T>(
    options: DurableObjectListOptions = {},
  ): IterableIterator<[string, T]> {
    const keys = [...this.map.keys()].sort();
    let count = 0;
    for (const key of options.reverse ? keys.reverse() : keys) {
      if (options.prefix !== undefined && !key.startsWith(options.prefix)) {
        continue;
      }
      if (options.start !== undefined && key < options.start) continue;
      if (options.startAfter !== undefined && key <= options.startAfter) {
        continue;
      }
      if (options.end !== undefined && key >= options.end) continue;
      if (options.limit !== undefined && count >= options.limit) return;
      count += 1;
      yield [key, structuredClone(this.map.get(key)) as T];
    }
  }
}

/** The `DurableObjectState` subset of {@link ContainerHost}, in memory. */
export class FakeState implements ContainerHost {
  readonly kv = new FakeKv();
  /** The scheduled alarm, in Unix milliseconds, or null. */
  alarm: number | null = null;
  readonly storage: ContainerHost["storage"];

  constructor(readonly container?: Container) {
    this.storage = {
      kv: this.kv,
      setAlarm: (at) => {
        this.alarm = typeof at === "number" ? at : at.getTime();
        return Promise.resolve();
      },
      getAlarm: () => Promise.resolve(this.alarm),
      deleteAlarm: () => {
        this.alarm = null;
        return Promise.resolve();
      },
    };
  }
}

/**
 * A clock for tests: `now()` moves only through `advance`, and `sleep`
 * advances it and yields to other tasks instead of waiting.
 */
export class ManualClock implements Clock {
  constructor(public time = Date.UTC(2026, 0, 1)) {}

  now(): number {
    return this.time;
  }

  advance(ms: number): void {
    this.time += ms;
  }

  async sleep(ms: number): Promise<void> {
    this.time += ms;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

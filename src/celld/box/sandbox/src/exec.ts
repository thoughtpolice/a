// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * One command through celld's native `ctx.container.exec`, with the limits
 * every sandbox command gets: a deadline (after which it is killed with
 * SIGKILL), and a cap on each output stream (the rest is read and dropped,
 * so a chatty command never blocks on a full pipe).
 *
 * The deadline is armed the moment the engine reports the process, before
 * any callback runs, and callbacks are bounded by it: a consumer that never
 * reads, reads slowly, cancels or throws cannot keep a command (or the
 * call) alive past it. `collect: false` keeps no output at all, for
 * streamed reads.
 *
 * @module
 */

import { nonNegativeMs, safeInt, strictRecord } from "@celld/core/bounds";
import type { NativeContainer } from "@celld/box/container";

/** How to run one command. */
export interface RawOptions {
  readonly cwd?: string;
  /** Passed to the engine; unused when the caller wraps argv in `env -i`. */
  readonly env?: Record<string, string>;
  readonly user?: string;
  readonly stdin?: Uint8Array | ReadableStream<Uint8Array>;
  /** The deadline; a finite, non-negative timer length (at most 2^31 - 1). */
  readonly timeoutMs: number;
  /** The bytes kept of each stream; a non-negative safe integer. */
  readonly maxOutputBytes: number;
  readonly combine?: boolean;
  /**
   * Keep the output in the result; default true. With false the result's
   * `stdout` and `stderr` are empty and output only reaches `onChunk`, so a
   * streamed read holds no more than the chunk in hand.
   */
  readonly collect?: boolean;
  /** Aborting it ends the command as a deadline does; `cancelled` is set. */
  readonly signal?: AbortSignal;
  /**
   * Called once the engine reports the pid, before any `onChunk`. The
   * deadline already runs; a callback still pending when it passes is
   * abandoned and the command is killed.
   */
  readonly onStart?: (pid: number) => void | Promise<void>;
  /**
   * Called with each kept chunk, in order per stream. While it is pending
   * that stream is not read (backpressure); at the deadline it is
   * abandoned. When it throws, the command is killed and `runRaw` rejects
   * with its error.
   */
  readonly onChunk?: (
    stream: "stdout" | "stderr",
    bytes: Uint8Array,
  ) => void | Promise<void>;
  /**
   * Kills whatever the command started, beyond the process the engine
   * knows (its process group, say); called before that process is killed
   * whenever the command is ended early. It must reject when it could not
   * kill: a hook that rejects, or has not settled within `killMs`, makes
   * the result `contained: false`.
   */
  readonly kill?: () => Promise<void>;
  /** How long the `kill` hook may take; default 10 s. */
  readonly killMs?: number;
  /**
   * Called and awaited when the `kill` hook failed or ran out of time,
   * before `runRaw` returns or throws: the last resort that stops what the
   * command started (the sandbox destroys the container). When it throws,
   * `runRaw` throws that.
   */
  readonly contain?: () => Promise<void>;
  /** How long to wait for output to drain after a kill; default 2 s. */
  readonly drainMs?: number;
}

/** What one command did, with its raw bytes. */
export interface RawResult {
  readonly exitCode: number | null;
  readonly stdout: Uint8Array;
  readonly stderr: Uint8Array;
  readonly timedOut: boolean;
  /** True when `signal` ended it. */
  readonly cancelled: boolean;
  /**
   * False when the run was ended early and its `kill` hook failed or did
   * not finish within `killMs`: whatever the command started may still be
   * running, and the caller must contain it (the sandbox destroys the
   * container). True otherwise, and always without a hook.
   */
  readonly contained: boolean;
  readonly truncated: boolean;
  readonly durationMs: number;
}

/** Concatenates chunks. */
export function concat(chunks: readonly Uint8Array[]): Uint8Array {
  const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

type Stop =
  | { readonly kind: "timeout" }
  | { readonly kind: "cancel" }
  | { readonly kind: "failed"; readonly error: unknown };

const STOPPED = Symbol("stopped");

// Whether `work` fulfilled within `ms`; the timer is cleared either way.
async function settledWithin(work: Promise<unknown>, ms: number) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<false>((resolve) => {
    timer = setTimeout(() => resolve(false), ms);
  });
  try {
    return await Promise.race([work.then(() => true, () => false), late]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Runs `argv` in `container`; see the module documentation. Throws a
 * `RangeError` (`BoundsError`), before anything runs, for a `timeoutMs`,
 * `killMs` or `drainMs` that is not a timer length, or a `maxOutputBytes`
 * that is not a non-negative safe integer.
 *
 * Everything after the engine starts the process happens under one
 * `finally`: the deadline is armed and both output streams are locked at
 * once, before `onStart` runs, and however the run ends (exit, deadline,
 * `signal`, a callback that throws or never settles) the process is killed
 * if it still runs, the readers are cancelled if they do not finish, and
 * stdin is closed.
 */
export async function runRaw(
  container: NativeContainer,
  argv: readonly string[],
  options: RawOptions,
): Promise<RawResult> {
  strictRecord(options, [
    "cwd",
    "env",
    "user",
    "stdin",
    "timeoutMs",
    "maxOutputBytes",
    "combine",
    "collect",
    "signal",
    "onStart",
    "onChunk",
    "kill",
    "killMs",
    "contain",
    "drainMs",
  ], "runRaw options");
  for (const name of ["combine", "collect"] as const) {
    if (options[name] !== undefined && typeof options[name] !== "boolean") {
      throw new TypeError(`${name} must be boolean`);
    }
  }
  for (const name of ["onStart", "onChunk", "kill", "contain"] as const) {
    if (options[name] !== undefined && typeof options[name] !== "function") {
      throw new TypeError(`${name} must be a function`);
    }
  }
  if (
    options.signal !== undefined && !(options.signal instanceof AbortSignal)
  ) throw new TypeError("signal must be an AbortSignal");
  const started = Date.now();
  const timeoutMs = nonNegativeMs(options.timeoutMs, { name: "timeoutMs" });
  const maxOutputBytes = safeInt(options.maxOutputBytes, {
    name: "maxOutputBytes",
    min: 0,
  });
  const killMs = nonNegativeMs(options.killMs ?? 10_000, { name: "killMs" });
  const drainMs = nonNegativeMs(options.drainMs ?? 2_000, { name: "drainMs" });
  options.signal?.throwIfAborted();
  const bytes = options.stdin instanceof Uint8Array ? options.stdin : null;
  const inputStop = new AbortController();
  const input = options.stdin instanceof ReadableStream
    ? options.stdin.pipeThrough(new TransformStream<Uint8Array, Uint8Array>(), {
      signal: options.signal === undefined
        ? inputStop.signal
        : AbortSignal.any([inputStop.signal, options.signal]),
    })
    : options.stdin;
  const process = await container.exec([...argv], {
    ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
    ...(options.env === undefined ? {} : { env: options.env }),
    ...(options.user === undefined ? {} : { user: options.user }),
    ...(options.stdin === undefined ? {} : {
      stdin: bytes === null ? input as ReadableStream<Uint8Array> : "pipe",
    }),
    stdout: "pipe",
    stderr: options.combine ? "combined" : "pipe",
  }).catch((error) => {
    inputStop.abort();
    throw error;
  });

  // From here on nothing may leave without the finally below.
  let stop: Stop | null = null;
  let stopNow: () => void = () => {};
  const stopped = new Promise<typeof STOPPED>((resolve) => {
    stopNow = () => resolve(STOPPED);
  });
  const halt = (why: Stop) => {
    if (stop !== null) return;
    stop = why;
    inputStop.abort();
    stopNow();
  };
  const timer = setTimeout(() => halt({ kind: "timeout" }), timeoutMs);
  const onAbort = () => halt({ kind: "cancel" });
  options.signal?.addEventListener("abort", onAbort, { once: true });
  // An abort while the engine was starting the process fired no listener:
  // it was checked before the await and listened for only now.
  if (options.signal?.aborted) onAbort();
  const readers: (ReadableStreamDefaultReader<Uint8Array> | null)[] = [
    null,
    null,
  ];
  let writer: WritableStreamDefaultWriter<Uint8Array> | null = null;
  const collect = options.collect ?? true;
  let truncated = false;
  // A callback, abandoned when the run stops first; a throw stops the run.
  const call = async (run: () => void | Promise<void>): Promise<boolean> => {
    try {
      const outcome = await Promise.race([
        Promise.resolve().then(run),
        stopped,
      ]);
      return outcome !== STOPPED;
    } catch (error) {
      halt({ kind: "failed", error });
      return false;
    }
  };

  try {
    readers[0] = process.stdout?.getReader() ?? null;
    readers[1] = process.stderr?.getReader() ?? null;
    writer = bytes !== null && process.stdin !== null
      ? process.stdin.getWriter()
      : null;
    const starting = options.onStart === undefined
      ? Promise.resolve(true)
      : call(() => options.onStart!(process.pid));
    const writing = writer === null ? Promise.resolve() : (async () => {
      try {
        if (bytes!.byteLength > 0) await writer.write(bytes!);
        await writer.close();
      } catch {
        // The command stopped reading; its exit status tells the story.
      }
    })();
    const drain = async (
      reader: ReadableStreamDefaultReader<Uint8Array> | null,
      name: "stdout" | "stderr",
    ): Promise<Uint8Array> => {
      if (reader === null) return new Uint8Array();
      const chunks: Uint8Array[] = [];
      let kept = 0;
      try {
        // Output waits in the pipe until onStart has been heard.
        if (!(await starting)) return new Uint8Array();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          const room = maxOutputBytes - kept;
          if (room <= 0) {
            truncated = true;
            continue;
          }
          const piece = value.byteLength > room
            ? value.subarray(0, room)
            : value;
          if (piece.byteLength < value.byteLength) truncated = true;
          kept += piece.byteLength;
          if (collect) chunks.push(piece);
          if (
            options.onChunk !== undefined &&
            !(await call(() => options.onChunk!(name, piece)))
          ) {
            break;
          }
        }
      } catch (error) {
        // A broken output transport must never manufacture successful partial output.
        if (stop === null) halt({ kind: "failed", error });
      }
      return concat(chunks);
    };
    const outputs = Promise.all([
      drain(readers[0], "stdout"),
      drain(readers[1], "stderr"),
    ]);
    const finished = Promise.all([outputs, process.exitCode, writing]);
    // A rejected exit status is a failure like any other.
    finished.catch((error) => halt({ kind: "failed", error }));
    await Promise.race([finished.then(() => {}, () => {}), stopped]);
    const ended = stop as Stop | null;
    let contained = true;
    if (ended !== null) {
      if (options.kill !== undefined) {
        // Reported, never swallowed: a kill that failed or hung leaves
        // the command's other processes running.
        contained = await settledWithin(
          Promise.resolve().then(options.kill),
          killMs,
        );
        if (!contained && options.contain !== undefined) {
          await options.contain();
        }
      }
      try {
        process.kill(9);
      } catch {
        // It exited in the meantime.
      }
      const drained = await settledWithin(finished, drainMs);
      if (!drained) {
        for (const reader of readers) reader?.cancel().catch(() => {});
      }
      if (ended.kind === "failed") throw ended.error;
    }
    const [stdout, stderr] = await outputs;
    // celld reports a killed exec's status unreliably; a stopped run is null.
    const exitCode = ended === null ? await process.exitCode : null;
    return {
      exitCode,
      stdout,
      stderr,
      timedOut: ended?.kind === "timeout",
      cancelled: ended?.kind === "cancel",
      contained,
      truncated,
      durationMs: Date.now() - started,
    };
  } catch (error) {
    // Includes getReader/getWriter failures before the normal run started.
    if (stop === null) {
      halt({ kind: "failed", error });
      if (
        options.kill !== undefined &&
        !(await settledWithin(Promise.resolve().then(options.kill), killMs))
      ) {
        await options.contain?.();
      }
      try {
        process.kill(9);
      } catch { /* Already exited. */ }
    }
    throw error;
  } finally {
    inputStop.abort();
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", onAbort);
    if (stop !== null) {
      // A producer's cancel/abort hook is arbitrary code: don't let an
      // uncooperative hook defeat the command's already elapsed deadline.
      await settledWithin(
        Promise.all([
          ...readers.map((reader) => reader?.cancel().catch(() => {})),
          writer?.abort().catch(() => {}),
        ]),
        drainMs,
      );
    }
    for (const reader of readers) {
      try {
        reader?.releaseLock();
      } catch { /* Pending engine cleanup. */ }
    }
    try {
      writer?.releaseLock();
    } catch { /* Pending engine cleanup. */ }
  }
}

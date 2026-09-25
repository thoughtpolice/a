// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * One command through celld's native `ctx.container.exec`, with the limits
 * every sandbox command gets: a deadline (after which it is killed with
 * SIGKILL), and a cap on each output stream (the rest is read and dropped,
 * so a chatty command never blocks on a full pipe).
 *
 * @module
 */

import type { NativeContainer } from "@celld/container";

/** How to run one command. */
export interface RawOptions {
  readonly cwd?: string;
  /** Passed to the engine; unused when the caller wraps argv in `env -i`. */
  readonly env?: Record<string, string>;
  readonly user?: string;
  readonly stdin?: Uint8Array | ReadableStream<Uint8Array>;
  readonly timeoutMs: number;
  readonly maxOutputBytes: number;
  readonly combine?: boolean;
  /** Called once the engine reports the pid. */
  readonly onStart?: (pid: number) => void | Promise<void>;
  /** Called with each kept chunk, in order per stream. */
  readonly onChunk?: (
    stream: "stdout" | "stderr",
    bytes: Uint8Array,
  ) => void | Promise<void>;
  /** How long to wait for output to drain after a kill; default 2 s. */
  readonly drainMs?: number;
}

/** What one command did, with its raw bytes. */
export interface RawResult {
  readonly exitCode: number | null;
  readonly stdout: Uint8Array;
  readonly stderr: Uint8Array;
  readonly timedOut: boolean;
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

const sleep = (ms: number) =>
  new Promise<"late">((resolve) => setTimeout(() => resolve("late"), ms));

/** Runs `argv` in `container`; see the module documentation. */
export async function runRaw(
  container: NativeContainer,
  argv: readonly string[],
  options: RawOptions,
): Promise<RawResult> {
  const started = Date.now();
  const bytes = options.stdin instanceof Uint8Array ? options.stdin : null;
  const process = await container.exec([...argv], {
    ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
    ...(options.env === undefined ? {} : { env: options.env }),
    ...(options.user === undefined ? {} : { user: options.user }),
    ...(options.stdin === undefined ? {} : {
      stdin: bytes === null
        ? options.stdin as ReadableStream<Uint8Array>
        : "pipe",
    }),
    stdout: "pipe",
    stderr: options.combine ? "combined" : "pipe",
  });
  if (options.onStart) await options.onStart(process.pid);
  let writing: Promise<void> = Promise.resolve();
  if (bytes !== null && process.stdin !== null) {
    const writer = process.stdin.getWriter();
    writing = (async () => {
      try {
        if (bytes.byteLength > 0) await writer.write(bytes);
        await writer.close();
      } catch {
        // The command stopped reading; its exit status tells the story.
      }
    })();
  }
  let truncated = false;
  const readers: ReadableStreamDefaultReader<Uint8Array>[] = [];
  const drain = async (
    stream: ReadableStream<Uint8Array> | null,
    name: "stdout" | "stderr",
  ): Promise<Uint8Array> => {
    if (stream === null) return new Uint8Array();
    const reader = stream.getReader();
    readers.push(reader);
    const chunks: Uint8Array[] = [];
    let kept = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        const room = options.maxOutputBytes - kept;
        if (room <= 0) {
          truncated = true;
          continue;
        }
        const piece = value.byteLength > room ? value.subarray(0, room) : value;
        if (piece.byteLength < value.byteLength) truncated = true;
        chunks.push(piece);
        kept += piece.byteLength;
        if (options.onChunk) await options.onChunk(name, piece);
      }
    } catch {
      // Cancelled after a timeout, or the engine dropped the stream.
    }
    return concat(chunks);
  };
  const outputs = Promise.all([
    drain(process.stdout, "stdout"),
    drain(process.stderr, "stderr"),
  ]);
  const finished = Promise.all([outputs, process.exitCode, writing]);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), options.timeoutMs);
  });
  let timedOut = false;
  try {
    const first = await Promise.race([finished, deadline]);
    if (first === "timeout") {
      timedOut = true;
      try {
        process.kill(9);
      } catch {
        // It exited in the meantime.
      }
      const late = await Promise.race([
        finished,
        sleep(options.drainMs ?? 2_000),
      ]);
      if (late === "late") {
        for (const reader of readers) reader.cancel().catch(() => {});
      }
    }
  } finally {
    clearTimeout(timer);
  }
  const [stdout, stderr] = await outputs;
  // celld reports a killed exec's status unreliably; a timeout is null.
  const exitCode = timedOut ? null : await process.exitCode;
  return {
    exitCode,
    stdout,
    stderr,
    timedOut,
    truncated,
    durationMs: Date.now() - started,
  };
}

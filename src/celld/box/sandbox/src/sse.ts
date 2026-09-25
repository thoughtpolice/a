// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * Server-sent events for sandbox streams: every event is
 * `event: <type>` plus `data: <JSON>`, so a stream can be handed straight
 * to a browser's `EventSource` or read back with {@link parseSSEStream}.
 *
 * @module
 */

import { nonNegativeMs, safeInt, strictRecord } from "@celld/core/bounds";
import { SandboxError } from "./errors.ts";
import type { SandboxEvent } from "./types.ts";

const encoder = new TextEncoder();

/** One event in SSE form. */
export function encodeEvent(
  event: SandboxEvent | { type: string },
): Uint8Array {
  if (
    typeof event.type !== "string" ||
    !/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(event.type)
  ) throw new SandboxError("invalid", "invalid SSE event type");
  return encoder.encode(
    `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`,
  );
}

/** The headers of an SSE response. */
export const SSE_HEADERS: HeadersInit = {
  "content-type": "text/event-stream; charset=utf-8",
  "cache-control": "no-store",
};

/** How a {@link boundedStream} holds bytes for its reader. */
export interface BoundedStreamOptions {
  /**
   * Bytes queued for the reader before `push` waits; default 64 KiB. A
   * safe integer of at least 1.
   */
  readonly highWaterMark?: number;
  /**
   * The longest one `push` waits for the reader to make room. Past it the
   * reader counts as gone: the stream fails and `signal` aborts. Default
   * 60 s; a timer length (at most 2^31 - 1).
   */
  readonly stallMs?: number;
}

/**
 * A byte stream `produce` writes with `push`, holding at most
 * `highWaterMark` bytes (plus the chunk being pushed) for its reader.
 *
 * `push` waits while the queue is full, so a slow reader slows the
 * producer instead of filling memory. `signal` aborts when the reader
 * cancels or stalls past `stallMs`; after that `push` rejects, and a
 * producer should stop its work (kill its command) promptly. When
 * `produce` rejects, the stream fails with its error. Bad options throw a
 * `RangeError` (`BoundsError`) before `produce` runs.
 */
export function boundedStream(
  produce: (
    push: (bytes: Uint8Array) => Promise<void>,
    signal: AbortSignal,
  ) => Promise<void>,
  options: BoundedStreamOptions = {},
): ReadableStream<Uint8Array> {
  strictRecord(
    options as unknown,
    ["highWaterMark", "stallMs"],
    "bounded stream options",
  );
  if (typeof produce !== "function") {
    throw new SandboxError("invalid", "stream producer must be a function");
  }
  const stallMs = nonNegativeMs(options.stallMs ?? 60_000, {
    name: "stallMs",
  });
  const highWaterMark = safeInt(options.highWaterMark ?? 64 * 1024, {
    name: "highWaterMark",
    min: 1,
  });
  const abort = new AbortController();
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  // Pushes waiting for room; stdout and stderr may both wait.
  const waiting = new Set<() => void>();
  const wake = () => {
    for (const resolve of [...waiting]) resolve();
    waiting.clear();
  };
  abort.signal.addEventListener("abort", wake);
  const stream = new ReadableStream<Uint8Array>(
    {
      start(c) {
        controller = c;
      },
      pull() {
        wake();
      },
      cancel(reason) {
        abort.abort(reason ?? new Error("the reader cancelled the stream"));
      },
    },
    new ByteLengthQueuingStrategy({
      highWaterMark,
    }),
  );
  const push = async (bytes: Uint8Array) => {
    const until = Date.now() + stallMs;
    while (!abort.signal.aborted && (controller.desiredSize ?? 0) <= 0) {
      const left = until - Date.now();
      if (left <= 0) {
        const stalled = new Error(
          `the reader took no data for ${stallMs} ms; the stream is closed`,
        );
        abort.abort(stalled);
        try {
          controller.error(stalled);
        } catch {
          // Already closed.
        }
        break;
      }
      let timer: ReturnType<typeof setTimeout> | undefined;
      let resolved: () => void = () => {};
      await new Promise<void>((resolve) => {
        resolved = resolve;
        waiting.add(resolve);
        timer = setTimeout(resolve, left);
      });
      waiting.delete(resolved);
      clearTimeout(timer);
    }
    abort.signal.throwIfAborted();
    controller.enqueue(bytes);
  };
  (async () => {
    try {
      await produce(push, abort.signal);
      if (!abort.signal.aborted) controller.close();
    } catch (error) {
      if (!abort.signal.aborted) {
        try {
          controller.error(error);
        } catch {
          // Already closed.
        }
      }
    }
  })();
  return stream;
}

/**
 * A byte stream of SSE events that `produce` emits, over a
 * {@link boundedStream}: `emit` waits for the reader when its queue is
 * full, and rejects once the reader cancelled or stalled, which `signal`
 * also reports. The stream ends when `produce` returns; if it throws, an
 * `error` event carries the message (when the reader is still there).
 */
export function eventStream(
  produce: (
    emit: (event: SandboxEvent) => Promise<void>,
    signal: AbortSignal,
  ) => Promise<void>,
  onError: (error: unknown) => { code: string; message: string },
  options: BoundedStreamOptions = {},
): ReadableStream<Uint8Array> {
  return boundedStream(async (push, signal) => {
    const emit = (event: SandboxEvent) => push(encodeEvent(event));
    try {
      await produce(emit, signal);
    } catch (error) {
      if (signal.aborted) return;
      try {
        await emit({ type: "error", ...onError(error) } as SandboxEvent);
      } catch {
        // The reader went away.
      }
    }
  }, options);
}

/** How {@link parseSSEStream} reads a stream. */
export interface ParseOptions<T> {
  /**
   * The most bytes one event may take before its blank line; default
   * 1 MiB. A peer that sends more (or never ends an event) fails the
   * stream with `too_large` instead of growing a buffer.
   */
  readonly maxEventBytes?: number;
  /**
   * Accepts an event's parsed data. The default accepts exactly the
   * sandbox's events ({@link isSandboxEvent}); pass your own for other
   * streams. Data that is not JSON, or that this refuses, fails the stream
   * with `invalid`.
   */
  readonly validate?: (value: unknown) => value is T;
}

const STRING_EVENT = new Set(["stdout", "stderr"]);
const STATUSES = new Set(["running", "exited", "killed", "timed_out", "lost"]);

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const isInt = (value: unknown) => Number.isSafeInteger(value);
const isIntOrNull = (value: unknown) => value === null || isInt(value);

/** Whether `value` is one of the events a sandbox stream carries. */
export function isSandboxEvent(value: unknown): value is SandboxEvent {
  if (!isObject(value) || typeof value.type !== "string") return false;
  switch (value.type) {
    case "start":
      return isInt(value.pid);
    case "stdout":
    case "stderr":
      return STRING_EVENT.has(value.type) && typeof value.data === "string";
    case "complete":
      return typeof value.success === "boolean" &&
        isIntOrNull(value.exitCode) && typeof value.timedOut === "boolean" &&
        typeof value.truncated === "boolean" &&
        typeof value.durationMs === "number" &&
        Number.isFinite(value.durationMs);
    case "exit":
      return typeof value.status === "string" && STATUSES.has(value.status) &&
        isIntOrNull(value.exitCode);
    case "error":
      return typeof value.code === "string" &&
        typeof value.message === "string";
    default:
      return false;
  }
}

const DEFAULT_EVENT_BYTES = 1024 * 1024;

/**
 * The events of an SSE byte stream, parsed from their JSON data and
 * checked (see {@link ParseOptions}). Blocks without `data` lines
 * (comments, keep-alives) are skipped. One event may take at most
 * `maxEventBytes` (1 MiB); a longer one, or data that is not a valid
 * event, fails the iteration with a `SandboxError` (`too_large`,
 * `invalid`), and the stream is cancelled.
 */
export async function* parseSSEStream<T = SandboxEvent>(
  stream: ReadableStream<Uint8Array>,
  options: ParseOptions<T> = {},
): AsyncGenerator<T> {
  strictRecord(
    options as unknown,
    ["maxEventBytes", "validate"],
    "SSE parser options",
  );
  if (
    options.validate !== undefined && typeof options.validate !== "function"
  ) throw new SandboxError("invalid", "SSE validator must be a function");
  const max = options.maxEventBytes ?? DEFAULT_EVENT_BYTES;
  if (!Number.isSafeInteger(max) || max < 1) {
    throw new RangeError("maxEventBytes must be a positive integer");
  }
  const validate = options.validate ??
    (isSandboxEvent as unknown as (value: unknown) => value is T);
  const reader = stream.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let buffer = new Uint8Array(Math.min(max + 1, 4096));
  let used = 0;
  let lineBytes = 0;
  let afterCR = false;
  const append = (byte: number) => {
    if (used >= max + 1) {
      throw new SandboxError(
        "too_large",
        `an event has more than ${max} bytes`,
      );
    }
    if (used === buffer.byteLength) {
      const larger = new Uint8Array(Math.min(max + 1, buffer.byteLength * 2));
      larger.set(buffer);
      buffer = larger;
    }
    buffer[used++] = byte;
  };
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return; // SSE dispatches only events terminated by a blank line.
      for (const byte of value) {
        if (afterCR) {
          afterCR = false;
          if (byte === 10) continue;
        }
        if (byte !== 10 && byte !== 13) {
          append(byte);
          lineBytes++;
          if (used > max) {
            throw new SandboxError(
              "too_large",
              `an event has more than ${max} bytes`,
            );
          }
          continue;
        }
        afterCR = byte === 13;
        if (lineBytes > 0) {
          append(10);
          lineBytes = 0;
          continue;
        }
        let block: string;
        try {
          block = decoder.decode(buffer.subarray(0, Math.max(0, used - 1)));
        } catch {
          throw new SandboxError("invalid", "an event is not valid UTF-8");
        }
        used = 0;
        const data = block.split("\n")
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).replace(/^ /, ""))
          .join("\n");
        if (data === "") continue;
        let parsed: unknown;
        try {
          parsed = JSON.parse(data);
        } catch {
          throw new SandboxError("invalid", "an event's data is not JSON");
        }
        if (validate(parsed) !== true) {
          throw new SandboxError(
            "invalid",
            "an event does not have the expected shape",
          );
        }
        yield parsed;
      }
    }
  } finally {
    // Stops the producer too when the consumer leaves early.
    // cancel closes the readable side synchronously; a producer's arbitrary
    // cancellation hook must not hold error reporting/early return hostage.
    reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

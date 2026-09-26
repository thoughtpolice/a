// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * Streamed body reads that stop at a byte cap.
 *
 * @module
 */

import { BoundsError, describe } from "./error.ts";
import { safeInt } from "./numbers.ts";
import { strictRecord } from "./record.ts";

const READ_KEYS = Object.freeze(["maxBytes", "signal"]);
const TEXT_KEYS = Object.freeze(["maxBytes", "signal", "fatal"]);

/** A body to read: a byte stream, or a `Request`/`Response` holding one. */
export type BoundedBody = ReadableStream<Uint8Array> | Request | Response;

/** How much to read, and when to give up. */
export interface ReadOptions {
  /** The most bytes accepted; one more is an error. */
  readonly maxBytes: number;
  /**
   * Aborting it cancels the body and rejects with the signal's reason, even
   * when the source never produces another chunk.
   */
  readonly signal?: AbortSignal;
}

/** {@link ReadOptions} for text. */
export interface ReadTextOptions extends ReadOptions {
  /** Reject malformed UTF-8 instead of replacing it with U+FFFD. */
  readonly fatal?: boolean;
}

const DIGITS = /^\s*(\d+)\s*$/;

function tooLarge(maxBytes: number, detail: string): BoundsError {
  return new BoundsError(
    "too_large",
    `the body is larger than ${maxBytes} bytes (${detail})`,
  );
}

function cancel(
  stream: ReadableStream | ReadableStreamDefaultReader,
  reason: unknown,
) {
  // Cancelling must not wait on the source: a hostile one may never settle.
  try {
    stream.cancel(reason).catch(() => {});
  } catch {
    // A locked stream cannot be cancelled here; its reader owns it.
  }
}

/**
 * Reads `body` to the end, keeping at most `maxBytes` bytes.
 *
 * The body is read chunk by chunk. The moment the total passes `maxBytes`
 * the source is cancelled and the read fails, so no more than the cap plus
 * the one chunk that crossed it is ever held. A chunked body with no
 * `Content-Length` is capped the same way. A `Content-Length` larger than
 * the cap is rejected before reading; a smaller one is not trusted. The
 * source is cancelled on every failure.
 *
 * @throws {BoundsError} `too_large` past the cap; `type` for a used or
 * locked body or a chunk that is not a `Uint8Array`; `range`/`type` for a
 * bad `maxBytes`. An abort rejects with the signal's reason.
 */
export async function readBounded(
  body: BoundedBody,
  options: ReadOptions,
): Promise<Uint8Array<ArrayBuffer>> {
  strictRecord(options, READ_KEYS, "read options");
  const maxBytes = safeInt(options.maxBytes, { name: "maxBytes", min: 0 });
  const { signal } = options;
  if (signal !== undefined && !(signal instanceof AbortSignal)) {
    throw new TypeError("signal must be an AbortSignal");
  }
  let stream: ReadableStream<Uint8Array> | null;
  if (body instanceof Request || body instanceof Response) {
    if (body.bodyUsed) {
      throw new BoundsError("type", "the body has already been read");
    }
    stream = body.body;
    const declared = DIGITS.exec(body.headers.get("content-length") ?? "");
    if (declared !== null && Number(declared[1]) > maxBytes) {
      const error = tooLarge(maxBytes, `Content-Length ${declared[1]}`);
      if (stream !== null) cancel(stream, error);
      throw error;
    }
  } else if (body instanceof ReadableStream) {
    stream = body;
  } else {
    throw new BoundsError("type", `cannot read a body from ${describe(body)}`);
  }
  if (stream === null) {
    signal?.throwIfAborted();
    return new Uint8Array(0);
  }
  if (stream.locked) {
    throw new BoundsError("type", "the body is locked by another reader");
  }
  if (signal?.aborted) {
    cancel(stream, signal.reason);
    throw signal.reason;
  }

  const reader = stream.getReader();
  let onAbort: (() => void) | undefined;
  const aborted = signal === undefined ? undefined : new Promise<never>(
    (_, reject) => {
      onAbort = () => reject(signal.reason);
      signal.addEventListener("abort", onAbort, { once: true });
    },
  );
  aborted?.catch(() => {});
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const next = reader.read();
      const { done, value } = aborted === undefined
        ? await next
        : await Promise.race([next, aborted]);
      if (done) break;
      if (!(value instanceof Uint8Array)) {
        throw new BoundsError(
          "type",
          `the body produced ${describe(value)}, not bytes`,
        );
      }
      total += value.length;
      if (total > maxBytes) throw tooLarge(maxBytes, `at least ${total} read`);
      // A producer may reuse its buffer on the next pull. Own these bytes now;
      // retaining zero-byte chunks would also bypass the byte-based memory cap.
      if (value.length !== 0) chunks.push(new Uint8Array(value));
    }
  } catch (error) {
    cancel(reader, error);
    throw error;
  } finally {
    if (onAbort !== undefined) signal!.removeEventListener("abort", onAbort);
    reader.releaseLock();
  }
  const result = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }
  return result;
}

/**
 * {@link readBounded}, decoded as UTF-8. A leading BOM is dropped and
 * malformed bytes become U+FFFD, as `Response.text()` does, unless `fatal`.
 *
 * @throws {BoundsError} as {@link readBounded}.
 * @throws {TypeError} for malformed UTF-8 when `fatal`.
 */
export async function readTextBounded(
  body: BoundedBody,
  options: ReadTextOptions,
): Promise<string> {
  strictRecord(options, TEXT_KEYS, "text read options");
  const { fatal } = options;
  if (fatal !== undefined && typeof fatal !== "boolean") {
    throw new TypeError("fatal must be boolean");
  }
  const bytes = await readBounded(body, {
    maxBytes: options.maxBytes,
    signal: options.signal,
  });
  return new TextDecoder("utf-8", { fatal: fatal === true }).decode(
    bytes,
  );
}

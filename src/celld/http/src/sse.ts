// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * Server-sent events both ways: a parser that follows the WHATWG "event
 * stream interpretation" rules, fed text in chunks of any size, and the
 * framing a server writes.
 *
 * - Lines end with CRLF, LF or CR, and a CRLF split across two chunks is one
 *   line ending, not two.
 * - `data:` lines accumulate, joined by LF; one leading space after the colon
 *   is dropped; lines starting with `:` are comments; unknown fields are
 *   ignored; an `id` containing NUL is ignored; `retry` must be digits.
 * - A blank line dispatches the event, unless no `data` was seen.
 * - UTF-8 is decoded with a streaming decoder, so a multi-byte character
 *   split across network chunks survives, and a leading BOM is dropped.
 *
 * At end of input the spec discards a half-received event. {@link
 * SseParser.finish} reports that as `truncated`, because for an API stream it
 * means the connection broke mid-event.
 *
 * What one event may hold is capped: the line being read plus the event's
 * data lines, in UTF-16 code units, may not pass `maxEventLength` (default
 * {@link DEFAULT_MAX_EVENT_LENGTH}). Past it the parser throws a
 * `BoundsError` with code `too_large`, so a stream that never sends a
 * newline or a blank line cannot grow without limit. The number of events a
 * stream carries is the consumer's to bound.
 *
 * @module
 */

import {
  BoundsError,
  MAX_TIMER_MS,
  safeInt,
  strictRecord,
} from "@celld/core/bounds";

/**
 * The default cap on one event: its data lines and the line being read,
 * 8 Mi UTF-16 code units.
 */
export const DEFAULT_MAX_EVENT_LENGTH = 8 * 1024 * 1024;

/** Options for {@link SseParser} and {@link sseEvents}. */
export interface SseOptions {
  /**
   * The most UTF-16 code units one event may hold, counting its data lines
   * and the line being read; default {@link DEFAULT_MAX_EVENT_LENGTH}.
   */
  readonly maxEventLength?: number;
}

/** One dispatched event. */
export interface SseEvent {
  /** The `event` field, or `"message"` when none was given. */
  readonly event: string;
  /** The `data` lines joined by LF. */
  readonly data: string;
  /** The last event id seen so far on this stream, or null. */
  readonly id: string | null;
  /**
   * A `retry` value given with this event, in milliseconds; values past
   * `MAX_TIMER_MS` are ignored, as a timer cannot hold them.
   */
  readonly retry: number | null;
}

/** What remained when the input ended. */
export interface SseFinish {
  /** Events dispatched by flushing the final line. */
  readonly events: SseEvent[];
  /** Whether an event had started (a field line) but was never dispatched. */
  readonly truncated: boolean;
}

/** An incremental parser over decoded text. */
export class SseParser {
  /**
   * The line being read, as the pieces it arrived in: joined only when the
   * line ends, so a long line fed in small chunks costs linear time.
   */
  #pending: string[] = [];
  /** UTF-16 code units in `#pending`. */
  #pendingLength = 0;
  #skipLf = false;
  #data: string[] = [];
  #event = "";
  #lastId: string | null = null;
  #retry: number | null = null;
  #started = false;
  #lines = 0;
  /** UTF-16 code units in `#data`, joining LFs included. */
  #held = 0;
  readonly #max: number;

  /**
   * @throws {RangeError} when `maxEventLength` is not a positive safe
   * integer.
   */
  constructor(options: SseOptions = {}) {
    strictRecord(options as unknown, ["maxEventLength"], "SSE options");
    this.#max = safeInt(options.maxEventLength ?? DEFAULT_MAX_EVENT_LENGTH, {
      name: "maxEventLength",
      min: 1,
    });
  }

  /** Lines processed so far, for diagnostics. */
  get lines(): number {
    return this.#lines;
  }

  /**
   * Feeds text; returns the events it completed, in order.
   *
   * @throws {BoundsError} (`too_large`) when an event outgrows
   * `maxEventLength`; the parser is then unusable.
   */
  push(text: string): SseEvent[] {
    const out: SseEvent[] = [];
    let chunk = text;
    if (this.#skipLf && chunk.length > 0) {
      if (chunk.charCodeAt(0) === 10) chunk = chunk.slice(1);
      this.#skipLf = false;
    }
    // Only the new text is scanned; the held pieces hold no line ending.
    let start = 0;
    for (let index = 0; index < chunk.length; index++) {
      const char = chunk.charCodeAt(index);
      if (char !== 10 && char !== 13) continue;
      const line = this.#take(chunk.slice(start, index));
      if (char === 13) {
        if (index + 1 < chunk.length) {
          if (chunk.charCodeAt(index + 1) === 10) index++;
        } else {
          // A CR at the end of this chunk; a LF may open the next one.
          this.#skipLf = true;
        }
      }
      start = index + 1;
      this.#line(line, out);
    }
    // What is left is the start of the next line.
    const rest = start === 0 ? chunk : chunk.slice(start);
    if (rest.length > 0) {
      this.#check(this.#pendingLength + rest.length);
      this.#pending.push(rest);
      this.#pendingLength += rest.length;
    }
    return out;
  }

  /** The held pieces of the line being read, then `tail`; clears them. */
  #take(tail: string): string {
    // Check before joining, and for complete lines too. Previously a complete
    // oversized id/event/unknown/comment line bypassed the only pending check.
    this.#check(this.#pendingLength + tail.length);
    if (this.#pending.length === 0) return tail;
    this.#pending.push(tail);
    const line = this.#pending.join("");
    this.#pending = [];
    this.#pendingLength = 0;
    return line;
  }

  #check(pending: number): void {
    if (this.#held + pending > this.#max) {
      throw new BoundsError(
        "too_large",
        `a server-sent event is longer than ${this.#max} characters`,
      );
    }
  }

  /**
   * Ends the input. A final line without a newline is processed first. The
   * parser may then be fed a new stream; the last event id carries over, as
   * it does when a client reconnects.
   */
  finish(): SseFinish {
    const events: SseEvent[] = [];
    if (this.#pendingLength > 0) this.#line(this.#take(""), events);
    const truncated = this.#started;
    this.#skipLf = false;
    this.#reset();
    return { events, truncated };
  }

  #reset(): void {
    this.#data = [];
    this.#held = 0;
    this.#event = "";
    this.#retry = null;
    this.#started = false;
  }

  #line(line: string, out: SseEvent[]): void {
    this.#lines++;
    if (line === "") {
      if (this.#data.length > 0) {
        out.push({
          event: this.#event === "" ? "message" : this.#event,
          data: this.#data.join("\n"),
          id: this.#lastId,
          retry: this.#retry,
        });
      }
      this.#reset();
      return;
    }
    if (line.charCodeAt(0) === 58) return; // ":" comment, such as a keep-alive
    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? "" : line.slice(colon + 1);
    if (value.charCodeAt(0) === 32) value = value.slice(1);
    switch (field) {
      case "data":
        this.#held += value.length + (this.#data.length > 0 ? 1 : 0);
        this.#data.push(value);
        this.#started = true;
        this.#check(0);
        break;
      case "event":
        this.#event = value;
        this.#started = true;
        break;
      case "id":
        if (!value.includes("\0")) this.#lastId = value;
        this.#started = true;
        break;
      case "retry":
        if (/^\d+$/.test(value) && Number(value) <= MAX_TIMER_MS) {
          this.#retry = Number(value);
        }
        this.#started = true;
        break;
      default:
        break;
    }
  }
}

/** Decodes UTF-8 bytes into text chunks, holding split characters back. */
export class Utf8Chunks {
  readonly #decoder = new TextDecoder("utf-8");

  /** The text in `bytes`, less any incomplete trailing character. */
  push(bytes: Uint8Array): string {
    return this.#decoder.decode(bytes, { stream: true });
  }

  /** Whatever was held back; invalid trailing bytes become U+FFFD. */
  finish(): string {
    return this.#decoder.decode();
  }
}

/**
 * Every event in a byte stream. Ends normally at end of input, or throws
 * `Error("truncated")` when the stream ends mid-event, and a `BoundsError`
 * when an event outgrows `maxEventLength`. Leaving the loop early (`break`,
 * `return()` or a throw, the consumer's or the cap's) cancels `body`, which
 * releases the connection behind a `fetch` response.
 */
export async function* sseEvents(
  body: ReadableStream<Uint8Array>,
  options: SseOptions = {},
): AsyncGenerator<SseEvent> {
  const parser = new SseParser(options);
  const utf8 = new Utf8Chunks();
  const reader = body.getReader();
  let ended = false;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      yield* parser.push(utf8.push(value));
    }
    ended = true;
    yield* parser.push(utf8.finish());
    const end = parser.finish();
    yield* end.events;
    if (end.truncated) throw new Error("truncated");
  } finally {
    if (!ended) await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

const encoder = new TextEncoder();

/**
 * One `message` event carrying a JSON value, as bytes. `JSON.stringify`
 * escapes every line ending, so the value is always a single `data` line.
 *
 * @throws {TypeError} when `value` has no JSON form (`undefined`, a function).
 */
export function sseMessage(value: unknown): Uint8Array {
  const json = JSON.stringify(value) as string | undefined;
  if (json === undefined) {
    throw new TypeError(`${typeof value} has no JSON form`);
  }
  return encoder.encode(`event: message\ndata: ${json}\n\n`);
}

/**
 * A comment line: a keep-alive clients must ignore. It is one shared
 * buffer; enqueue it only on streams that do not transfer their chunks
 * (default `ReadableStream`s, not byte streams).
 */
export const SSE_KEEPALIVE: Uint8Array = encoder.encode(":\n\n");

// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

import {
  assert,
  assertEquals,
  assertRejects,
  assertThrows,
} from "@celld/core/assert";
import { BoundsError } from "@celld/core/bounds";
import {
  DEFAULT_MAX_EVENT_LENGTH,
  SSE_KEEPALIVE,
  sseEvents,
  sseMessage,
  SseParser,
  Utf8Chunks,
} from "@celld/http/sse";

function all(chunks: string[]) {
  const parser = new SseParser();
  const events = chunks.flatMap((chunk) => parser.push(chunk));
  const end = parser.finish();
  return { events: [...events, ...end.events], truncated: end.truncated };
}

function stream(chunks: (string | Uint8Array)[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(
          typeof chunk === "string" ? encoder.encode(chunk) : chunk,
        );
      }
      controller.close();
    },
  });
}

Deno.test("one event per blank line, with the event name and data", () => {
  const { events, truncated } = all([
    'event: response.created\ndata: {"a":1}\n\nevent: x\ndata: 2\n\n',
  ]);
  assertEquals(events.map((e) => [e.event, e.data]), [[
    "response.created",
    '{"a":1}',
  ], ["x", "2"]]);
  assert(!truncated, "not truncated");
});

Deno.test("an event without a name is a message", () => {
  assertEquals(all(["data: hi\n\n"]).events[0].event, "message");
});

Deno.test("multiple data lines join with LF", () => {
  assertEquals(all(["data: a\ndata: b\ndata:\n\n"]).events[0].data, "a\nb\n");
});

Deno.test("only one space after the colon is dropped", () => {
  assertEquals(
    all(["data:  two\n\n", "data:none\n\n"]).events.map((e) => e.data),
    [" two", "none"],
  );
});

Deno.test("comments and unknown fields are ignored", () => {
  const { events } = all([": keepalive\nfoo: bar\ndata: x\n\n: ping\n\n"]);
  assertEquals(events.map((e) => e.data), ["x"]);
});

Deno.test("CRLF, CR and LF all end lines", () => {
  const { events } = all(["data: a\r\n\r\ndata: b\r\rdata: c\n\n"]);
  assertEquals(events.map((e) => e.data), ["a", "b", "c"]);
});

Deno.test("a CRLF split across chunks is one line ending", () => {
  const { events } = all(["data: a\r", "\n\r", "\ndata: b\r", "\r"]);
  assertEquals(events.map((e) => e.data), ["a", "b"]);
});

Deno.test("an event split at every character reassembles", () => {
  const text =
    'event: response.output_text.delta\r\ndata: {"delta":"héllo 🌍"}\r\n\r\n';
  const { events } = all([...text]);
  assertEquals(events.length, 1);
  assertEquals(JSON.parse(events[0].data).delta, "héllo 🌍");
});

Deno.test("an event with no data is not dispatched", () => {
  assertEquals(all(["event: ping\n\n", "id: 7\n\n"]).events, []);
});

Deno.test("id persists and ignores values with NUL; retry must be digits", () => {
  const { events } = all([
    "id: 1\ndata: a\n\ndata: b\n\nid: x\0y\nretry: 12\ndata: c\n\nretry: 1s\ndata: d\n\n",
  ]);
  assertEquals(events.map((e) => [e.id, e.retry]), [["1", null], ["1", null], [
    "1",
    12,
  ], ["1", null]]);
});

Deno.test("input ending mid-event is reported as truncated and not dispatched", () => {
  const { events, truncated } = all(["data: whole\n\ndata: half"]);
  assertEquals(events.map((e) => e.data), ["whole"]);
  assert(truncated, "truncated");
  assert(!all(["data: whole\n\n"]).truncated, "a clean end is not truncated");
  assert(
    all(["data: whole\n\nevent: x\n"]).truncated,
    "a started event without its blank line is",
  );
});

Deno.test("UTF-8 split across byte chunks decodes once whole", () => {
  const bytes = new TextEncoder().encode("é🌍");
  const utf8 = new Utf8Chunks();
  let text = "";
  for (const byte of bytes) text += utf8.push(new Uint8Array([byte]));
  text += utf8.finish();
  assertEquals(text, "é🌍");
});

Deno.test("Daybreak complete SSE lines cannot bypass the cap at any chunk boundary", () => {
  for (const prefix of ["id:", "event:", ":", "unknown:", "data:"]) {
    const line = `${prefix}${"x".repeat(65)}\n`;
    for (let split = 0; split <= line.length; split++) {
      const parser = new SseParser({ maxEventLength: 64 });
      assertThrows(() => {
        parser.push(line.slice(0, split));
        parser.push(line.slice(split));
      }, RangeError);
    }
  }
  assertThrows(() => new SseParser({ maxEventLenght: 64 } as never), TypeError);
});

Deno.test("sseEvents reads a byte stream, dropping a BOM", async () => {
  const bom = new Uint8Array([0xef, 0xbb, 0xbf]);
  const events = [];
  for await (
    const event of sseEvents(stream([bom, "data: 1\n", "\ndata: 2\n\n"]))
  ) events.push(event.data);
  assertEquals(events, ["1", "2"]);
});

Deno.test("sseEvents throws on a truncated stream", async () => {
  let message = "";
  try {
    for await (
      const _ of sseEvents(stream(["data: 1\n\ndata: 2"]))
    ) { /* drain */ }
  } catch (error) {
    message = (error as Error).message;
  }
  assertEquals(message, "truncated");
});

Deno.test("a large data line survives many small chunks", () => {
  const big = "x".repeat(200_000);
  const text = `data: ${big}\n\n`;
  const chunks: string[] = [];
  for (let i = 0; i < text.length; i += 997) {
    chunks.push(text.slice(i, i + 997));
  }
  assertEquals(all(chunks).events[0].data.length, 200_000);
});

Deno.test("a parser counts lines and can be fed a second stream", () => {
  const parser = new SseParser();
  parser.push("id: 4\ndata: a\n\ndata: b");
  assertEquals(parser.lines, 3);
  const end = parser.finish();
  assert(end.truncated, "the first stream broke mid-event");
  assertEquals(end.events, []);
  assertEquals(parser.push("data: c\n\n"), [{
    event: "message",
    data: "c",
    id: "4",
    retry: null,
  }]);
});

Deno.test("leaving sseEvents early cancels the body", async () => {
  let cancelled: unknown = "not cancelled";
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      controller.enqueue(new TextEncoder().encode("data: tick\n\n"));
    },
    cancel(reason) {
      cancelled = reason;
    },
  });
  for await (const event of sseEvents(body)) {
    assertEquals(event.data, "tick");
    break;
  }
  assertEquals(cancelled, undefined);
  assert(!body.locked, "the lock is released");
});

Deno.test("sseMessage frames one JSON value; the keep-alive is a comment", () => {
  const decode = (bytes: Uint8Array) => new TextDecoder().decode(bytes);
  const text = decode(sseMessage({ text: "two\nlines", n: 1 }));
  assertEquals(text, 'event: message\ndata: {"text":"two\\nlines","n":1}\n\n');
  assertEquals(all([text]).events.map((e) => JSON.parse(e.data)), [{
    text: "two\nlines",
    n: 1,
  }]);
  assertEquals(decode(SSE_KEEPALIVE), ":\n\n");
  assertEquals(all([decode(SSE_KEEPALIVE)]), { events: [], truncated: false });
  let error: unknown;
  try {
    sseMessage(undefined);
  } catch (caught) {
    error = caught;
  }
  assert(error instanceof TypeError, "undefined has no JSON form");
});

// DB-SWP-F1-1: the parser buffered a line, and the data lines of an event,
// without limit, so a stream that never sends a newline or a blank line
// grew until the isolate ran out of memory.
Deno.test("a line that never ends is refused at the cap", () => {
  const parser = new SseParser({ maxEventLength: 1024 });
  parser.push("data: ");
  const error = assertThrows(
    () => {
      for (let i = 0; i < 100; i++) parser.push("x".repeat(64));
    },
    BoundsError,
    "1024",
  );
  assertEquals(error.code, "too_large");
});

Deno.test("an event whose data lines never end is refused at the cap", () => {
  const parser = new SseParser({ maxEventLength: 1024 });
  assertThrows(
    () => {
      for (let i = 0; i < 1000; i++) parser.push("data: 0123456789\n");
    },
    BoundsError,
  );
  const fits = new SseParser({ maxEventLength: 1024 });
  const events = fits.push(`data: ${"y".repeat(1000)}\n\n`.repeat(50));
  assertEquals(events.length, 50);
});

Deno.test("the default cap applies without options", () => {
  assert(DEFAULT_MAX_EVENT_LENGTH >= 1024 * 1024, "a generous default");
  const parser = new SseParser();
  assertThrows(
    () => parser.push(`data: ${"z".repeat(DEFAULT_MAX_EVENT_LENGTH)}`),
    BoundsError,
  );
  assertThrows(() => new SseParser({ maxEventLength: Number.NaN }), RangeError);
  assertThrows(() => new SseParser({ maxEventLength: -1 }), RangeError);
});

// DB-SWP-F7-2: `retry` is a reconnection delay; a value past a timer's
// range (or past a safe integer) would fire at once.
Deno.test("a retry beyond a timer's range is ignored", () => {
  const { events } = all([
    `retry: ${
      "9".repeat(30)
    }\ndata: a\n\nretry: 2147483648\ndata: b\n\nretry: 3000\ndata: c\n\n`,
  ]);
  assertEquals(events.map((event) => event.retry), [null, null, 3000]);
});

Deno.test("sseEvents stops a stream without newlines and cancels it", async () => {
  let pulls = 0;
  let cancelled: unknown = null;
  const endless = new ReadableStream<Uint8Array>({
    pull(controller) {
      pulls++;
      controller.enqueue(new TextEncoder().encode("data: " + "x".repeat(250)));
    },
    cancel(reason) {
      cancelled = reason;
    },
  });
  await assertRejects(
    async () => {
      for await (const _ of sseEvents(endless, { maxEventLength: 4096 })) {
        // never reached
      }
    },
    BoundsError,
  );
  assert(pulls < 40, `read ${pulls} chunks`);
  assert(cancelled !== null, "the body was cancelled");
});

// DB-REV-JWT-2: each push appended to the held line and rescanned it as a
// flat string, so one long unterminated line in small writes cost time
// quadratic in its length (about 160 s for the default cap in 64-character
// chunks).
Deno.test("a long line in small chunks parses in linear time", () => {
  const parser = new SseParser();
  const chunk = "x".repeat(64);
  const total = DEFAULT_MAX_EVENT_LENGTH - 16;
  const started = performance.now();
  let pushed = 0;
  parser.push("data:");
  while (pushed + chunk.length <= total - 5) {
    assertEquals(parser.push(chunk), []);
    pushed += chunk.length;
    // Fail fast rather than run for minutes when the parse is quadratic.
    if ((pushed & 0xfffff) === 0) {
      const elapsed = performance.now() - started;
      assert(elapsed < 5_000, `${pushed} characters took ${elapsed} ms`);
    }
  }
  const events = parser.push("\n\n");
  const elapsed = performance.now() - started;
  assert(elapsed < 5_000, `the whole line took ${elapsed} ms`);
  assertEquals(events.length, 1);
  assertEquals(events[0].data.length, pushed);
  // One more character past the cap on a new line still throws.
  const capped = new SseParser({ maxEventLength: 1000 });
  for (let index = 0; index < 15; index++) capped.push(chunk);
  assertThrows(() => capped.push(chunk), BoundsError, "longer than 1000");
});

Deno.test("a CR at a chunk end followed by LF, amid a long held line", () => {
  const parser = new SseParser();
  assertEquals(parser.push("data: a"), []);
  assertEquals(parser.push("b"), []);
  assertEquals(parser.push("c\r"), []);
  const events = parser.push("\n\r\n");
  assertEquals(events.map((event) => event.data), ["abc"]);
  assertEquals(parser.push("data: z\r"), []);
  assertEquals(parser.push("\r"), [
    { event: "message", data: "z", id: null, retry: null },
  ]);
});

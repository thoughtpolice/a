// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

import { assert, assertEquals } from "@celld/assert";
import {
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

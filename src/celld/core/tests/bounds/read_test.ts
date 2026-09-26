// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

import { assert, assertEquals, assertRejects } from "./assert.ts";
import {
  BoundsError,
  readBounded,
  type ReadOptions,
  readTextBounded,
  type ReadTextOptions,
} from "@celld/core/bounds";

Deno.test("byte reads own each nonempty chunk before the producer reuses its buffer", async () => {
  const reused = new Uint8Array(2);
  let index = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (++index > 3) {
        controller.close();
        return;
      }
      reused.fill(index);
      controller.enqueue(reused);
    },
  }, { highWaterMark: 0 });
  assertEquals(
    await readBounded(stream, { maxBytes: 6 }),
    new Uint8Array([1, 1, 2, 2, 3, 3]),
  );
  assertEquals(stream.locked, false);
  // Empty producer chunks consume no retained chunk slots, even at a zero cap.
  const empty = source(0, 10_000);
  assertEquals(
    await readBounded(empty.stream, { maxBytes: 0 }),
    new Uint8Array(0),
  );
});

Deno.test("reader locks are released on overflow and abort even if cancellation never settles", async () => {
  for (const abort of [false, true]) {
    let cancelled = false;
    const controller = new AbortController();
    const stream = new ReadableStream<Uint8Array>({
      pull(output) {
        if (!abort) output.enqueue(new Uint8Array(2));
      },
      cancel() {
        cancelled = true;
        return new Promise<void>(() => {});
      },
    }, { highWaterMark: 0 });
    const pending = readBounded(stream, {
      maxBytes: 1,
      signal: controller.signal,
    });
    if (abort) controller.abort(new Error("stop"));
    await assertRejects(pending);
    assert(cancelled, "source cancelled without awaiting its promise");
    assertEquals(stream.locked, false);
  }
  const aborted = AbortSignal.abort(new Error("empty body deadline"));
  await assertRejects(() =>
    readBounded(new Response(null), { maxBytes: 0, signal: aborted })
  );
});

Deno.test("read options are exact data dictionaries and text fatal is a boolean snapshot", async () => {
  for (
    const options of [
      { maxBytes: 1, maxByte: 1 },
      { maxBytes: 1, signal: null },
      { maxBytes: 1, signal: {} },
      { maxBytes: 1, fatal: true },
      null,
    ]
  ) {
    await assertRejects(
      () => readBounded(new Response("x"), options as ReadOptions),
      TypeError,
    );
  }
  for (const fatal of ["true", 1, null]) {
    await assertRejects(
      () =>
        readTextBounded(
          new Response("x"),
          { maxBytes: 1, fatal } as unknown as ReadTextOptions,
        ),
      TypeError,
    );
  }
  let invoked = false;
  await assertRejects(() =>
    readBounded(new Response("x"), {
      get maxBytes() {
        invoked = true;
        return 1;
      },
    }), TypeError);
  assertEquals(invoked, false);
  const options = { maxBytes: 1, fatal: true };
  const pending = readTextBounded(
    new Response(new Uint8Array([0xff])),
    options,
  );
  options.fatal = false;
  await assertRejects(pending, TypeError);
  assertEquals(
    await readTextBounded(new Response("x"), { maxBytes: 1, fatal: true }),
    "x",
  );
});

interface Source {
  readonly stream: ReadableStream<Uint8Array>;
  /** Chunks the consumer pulled. */
  readonly pulled: () => number;
  /** The reason the consumer cancelled with, or undefined. */
  readonly cancelled: () => unknown;
  readonly wasCancelled: () => boolean;
}

/** A chunked stream of `chunks` chunks of `size` bytes; endless when null. */
function source(size: number, chunks: number | null): Source {
  let pulled = 0;
  let cancelled = false;
  let reason: unknown;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (chunks !== null && pulled >= chunks) {
        controller.close();
        return;
      }
      pulled++;
      controller.enqueue(new Uint8Array(size).fill(0x61));
    },
    cancel(why) {
      cancelled = true;
      reason = why;
    },
  }, { highWaterMark: 0 });
  return {
    stream,
    pulled: () => pulled,
    cancelled: () => reason,
    wasCancelled: () => cancelled,
  };
}

Deno.test("reads a chunked body under the cap", async () => {
  const s = source(10, 5);
  const body = await readBounded(s.stream, { maxBytes: 50 });
  assertEquals(body.length, 50);
  assertEquals(s.wasCancelled(), false);
});

Deno.test("stops at the cap on an endless chunked body and cancels it", async () => {
  const s = source(10, null);
  const error = await assertRejects(
    () => readBounded(s.stream, { maxBytes: 95 }),
    BoundsError,
  );
  assertEquals(error.code, "too_large");
  // 9 chunks fit (90 bytes); the 10th crosses 95. Nothing past it is pulled.
  assertEquals(s.pulled(), 10);
  assert(s.wasCancelled(), "the source is cancelled");
  assert(s.cancelled() instanceof BoundsError, "cancelled with the error");
});

Deno.test("a cap of exactly the body size is enough", async () => {
  const s = source(10, 3);
  assertEquals((await readBounded(s.stream, { maxBytes: 30 })).length, 30);
});

Deno.test("Response without Content-Length is still capped", async () => {
  const s = source(1000, null);
  const response = new Response(s.stream);
  assertEquals(response.headers.get("content-length"), null);
  const error = await assertRejects(
    () => readBounded(response, { maxBytes: 4096 }),
    BoundsError,
  );
  assertEquals(error.code, "too_large");
  assert(s.pulled() <= 5, `pulled ${s.pulled()} chunks`);
});

Deno.test("a lying small Content-Length does not raise the cap", async () => {
  const s = source(100, 10);
  const response = new Response(s.stream, {
    headers: { "content-length": "10" },
  });
  const error = await assertRejects(
    () => readBounded(response, { maxBytes: 250 }),
    BoundsError,
  );
  assertEquals(error.code, "too_large");
});

Deno.test("a large Content-Length is rejected before reading", async () => {
  const s = source(10, 1);
  const response = new Response(s.stream, {
    headers: { "content-length": "1000000" },
  });
  const error = await assertRejects(
    () => readBounded(response, { maxBytes: 100 }),
    BoundsError,
  );
  assertEquals(error.code, "too_large");
  assertEquals(s.pulled(), 0);
  assert(s.wasCancelled(), "the body is cancelled");
});

Deno.test("Request bodies and null bodies", async () => {
  const request = new Request("https://example.com/", {
    method: "POST",
    body: "hello",
  });
  assertEquals(await readTextBounded(request, { maxBytes: 5 }), "hello");
  assertEquals(
    (await readBounded(new Response(null), { maxBytes: 0 })).length,
    0,
  );
  await assertRejects(
    () => readTextBounded(new Response("hello!"), { maxBytes: 5 }),
    BoundsError,
  );
});

Deno.test("a used body is refused", async () => {
  const response = new Response("x");
  await response.text();
  const error = await assertRejects(
    () => readBounded(response, { maxBytes: 5 }),
    BoundsError,
  );
  assertEquals(error.code, "type");
});

Deno.test("non-byte chunks are refused and the source cancelled", async () => {
  let cancelled = false;
  const stream = new ReadableStream({
    pull(controller) {
      controller.enqueue("text" as unknown as Uint8Array);
    },
    cancel() {
      cancelled = true;
    },
  });
  const error = await assertRejects(
    () => readBounded(stream as ReadableStream<Uint8Array>, { maxBytes: 100 }),
    BoundsError,
  );
  assertEquals(error.code, "type");
  assert(cancelled, "cancelled");
});

Deno.test("maxBytes is validated", async () => {
  for (const maxBytes of [Number.NaN, -1, 1.5, Number.POSITIVE_INFINITY]) {
    await assertRejects(
      () => readBounded(new Response("x"), { maxBytes }),
      RangeError,
    );
  }
});

Deno.test("an abort signal stops an endless read and cancels it", async () => {
  const s = source(1, null);
  const slow = new ReadableStream<Uint8Array>({
    start() {},
    cancel(reason) {
      void s.stream.cancel(reason);
    },
  });
  const controller = new AbortController();
  const reason = new Error("deadline");
  setTimeout(() => controller.abort(reason), 10);
  const error = await assertRejects(() =>
    readBounded(slow, { maxBytes: 100, signal: controller.signal })
  );
  assertEquals(error, reason);
  assert(s.wasCancelled(), "the stream is cancelled");
});

Deno.test("text is decoded as UTF-8 across chunk boundaries", async () => {
  const bytes = new TextEncoder().encode("héllo €");
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const byte of bytes) controller.enqueue(new Uint8Array([byte]));
      controller.close();
    },
  });
  assertEquals(await readTextBounded(stream, { maxBytes: 64 }), "héllo €");
});

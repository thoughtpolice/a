// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

// DB-RTR-008: URL and query limits before any parsing, one pass when the
// query is parsed, and no parsing when nothing asks for it.
// DB-RTR-009: body reads observe c.signal, and c.req's body goes through
// the streamed limit.

import { assert, assertEquals, assertThrows } from "@celld/core/assert";
import { router, RouterError } from "@celld/web/router";
import { v } from "@celld/sieve";
import { assertMatch, assertStatus, call } from "./fixture.ts";

function keys(count: number): string {
  return Array.from({ length: count }, (_, i) => `k${i}=${i}`).join("&");
}

Deno.test("URLs and queries over the limits are refused before parsing", async () => {
  const app = router({
    auth: "none",
    limits: { maxUrlBytes: 128, maxQueryBytes: 64, maxQueryFields: 4 },
  });
  let ran = 0;
  app.get("/*rest", (c) => {
    ran++;
    return c.json(c.query);
  });
  assertEquals((await call(app, "/a?x=1&x=2")).json, { x: ["1", "2"] });
  const long = await call(app, `/${"a".repeat(200)}`);
  assertStatus(long, 414);
  assertMatch(long.json, { error: "uri_too_long" });
  assertStatus(await call(app, `/a?q=${"b".repeat(70)}`), 414);
  const fields = await call(app, "/a?a&b&c&d&e");
  assertStatus(fields, 400);
  assertMatch(fields.json, { error: "too_many_query_fields" });
  assertEquals(
    (await call(app, "/a?a&&b&c&d&")).json,
    { a: "", b: "", c: "", d: "" },
    "empty pieces are not fields",
  );
  assertEquals(ran, 2);
});

Deno.test("the defaults are 16 KiB of URL and 256 query fields", async () => {
  const app = router({ auth: "none" });
  app.get("/", (c) => c.json(Object.keys(c.query).length));
  assertEquals((await call(app, `/?${keys(256)}`)).json, 256);
  assertStatus(await call(app, `/?${keys(257)}`), 400);
  assertStatus(await call(app, `/?q=${"x".repeat(16 * 1024)}`), 414);
});

Deno.test("40 000 distinct query keys are refused fast", async () => {
  const app = router({ auth: "none" });
  app.get("/", (c) => c.json(Object.keys(c.query).length));
  const started = performance.now();
  assertStatus(await call(app, `/?${keys(40_000)}`), 414);
  const roomy = router({
    auth: "none",
    limits: {
      maxUrlBytes: 1024 * 1024,
      maxQueryBytes: 1024 * 1024,
    },
  });
  roomy.get("/", (c) => c.json(Object.keys(c.query).length));
  assertStatus(await call(roomy, `/?${keys(40_000)}`), 400);
  const elapsed = performance.now() - started;
  assert(elapsed < 1000, `refused in ${elapsed} ms`);
});

Deno.test("an allowed query is parsed in one pass", async () => {
  const app = router({
    auth: "none",
    limits: {
      maxUrlBytes: 1024 * 1024,
      maxQueryBytes: 1024 * 1024,
      maxQueryFields: 50_000,
    },
  });
  app.get("/", (c) => c.json(Object.keys(c.query).length));
  const query = `/?${keys(40_000)}`;
  const started = performance.now();
  assertEquals((await call(app, query)).json, 40_000);
  const elapsed = performance.now() - started;
  assert(elapsed < 1000, `parsed in ${elapsed} ms`);
});

Deno.test("the query is parsed only when the route has a schema or c.query is read", async () => {
  const original = URLSearchParams.prototype[Symbol.iterator];
  let iterations = 0;
  URLSearchParams.prototype[Symbol.iterator] = function () {
    iterations++;
    return original.call(this);
  };
  try {
    const app = router({ auth: "none" });
    app.get("/plain", (c) => c.text("x"));
    app.get("/reads", (c) => c.json(c.query));
    app.get(
      "/schema",
      { query: v.object({ q: v.string() }) },
      (c) => c.text(c.query.q),
    );
    await call(app, "/plain?q=1");
    assertEquals(iterations, 0, "no schema, not read: not parsed");
    assertEquals((await call(app, "/reads?q=1")).json, { q: "1" });
    assertEquals(iterations, 1);
    assertEquals((await call(app, "/schema?q=1")).text, "1");
    assertEquals(iterations, 2);
  } finally {
    URLSearchParams.prototype[Symbol.iterator] = original;
  }
});

Deno.test("URL and query limits are checked when the router is made", () => {
  for (
    const limits of [
      { maxUrlBytes: 0 },
      { maxQueryBytes: -1 },
      { maxQueryFields: 1.5 },
      { maxUrlBytes: Infinity },
    ]
  ) {
    assertThrows(
      () => router({ auth: "none", limits }),
      RouterError,
      "must be a positive integer",
    );
  }
});

// DB-RTR-009

/** A chunked body: `size` bytes in 16-byte chunks, no Content-Length. */
function chunked(size: number): ReadableStream<Uint8Array> {
  let sent = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (sent >= size) {
        controller.close();
        return;
      }
      const chunk = new Uint8Array(Math.min(16, size - sent)).fill(0x61);
      sent += chunk.length;
      controller.enqueue(chunk);
    },
  });
}

Deno.test("c.req's body methods go through the streamed limit", async () => {
  const app = router({ auth: "none", limits: { body: 64 } });
  app.post("/text", async (c) => c.text(String((await c.req.text()).length)));
  app.post(
    "/bytes",
    async (c) => c.text(String((await c.req.arrayBuffer()).byteLength)),
  );
  app.post("/json", async (c) => c.json(await c.req.json()));
  app.post("/stream", async (c) => {
    let total = 0;
    for await (const chunk of c.req.body!) total += chunk.length;
    return c.text(String(total));
  });
  for (const path of ["/text", "/bytes", "/stream"]) {
    assertEquals(
      (await call(app, path, { method: "POST", body: chunked(64) })).text,
      "64",
      path,
    );
    const over = await call(app, path, { method: "POST", body: chunked(65) });
    assertStatus(over, 413);
  }
  assertEquals(
    (await call(app, "/json", { json: { a: 1 } })).json,
    { a: 1 },
  );
  assertStatus(
    await call(app, "/json", { json: { a: "x".repeat(100) } }),
    413,
  );
});

Deno.test("c.unsafeRequest is the request as it arrived", async () => {
  const app = router({ auth: "none", limits: { body: 8 } });
  app.post("/", async (c) => {
    assert(c.unsafeRequest !== c.req, "a different object");
    assertEquals(c.req.url, c.unsafeRequest.url);
    assertEquals(c.req.method, "POST");
    assertEquals(c.req.headers.get("x-a"), "1");
    return c.text(String((await c.unsafeRequest.text()).length));
  });
  assertEquals(
    (await call(app, "/", {
      method: "POST",
      body: chunked(20),
      headers: { "x-a": "1" },
    })).text,
    "20",
  );
});

Deno.test("a chunked body over the limit is refused by every reader", async () => {
  const app = router({ auth: "none", limits: { body: 32 } });
  app.post("/bytes", async (c) => c.text(String((await c.readBytes()).length)));
  app.post("/text", async (c) => c.text(await c.readText()));
  app.post("/schema", { body: v.unknown() }, (c) => c.json(c.body));
  for (const path of ["/bytes", "/text"]) {
    assertStatus(
      await call(app, path, { method: "POST", body: chunked(33) }),
      413,
    );
  }
  assertStatus(
    await call(app, "/schema", {
      method: "POST",
      body: chunked(33),
      headers: { "content-type": "application/json" },
    }),
    413,
  );
});

/** A body that sends one chunk and then never another; records its cancel. */
function stalled(): {
  stream: ReadableStream<Uint8Array>;
  cancelled: unknown[];
} {
  const cancelled: unknown[] = [];
  let first = true;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (first) {
        first = false;
        controller.enqueue(new Uint8Array([0x61]));
        return;
      }
      return new Promise<void>(() => {});
    },
    cancel(reason) {
      cancelled.push(reason);
    },
  });
  return { stream, cancelled };
}

Deno.test("the time budget cancels a body read in progress", async () => {
  for (const reader of ["readBytes", "req.text"] as const) {
    const app = router({ auth: "none", limits: { timeout: 0.05 } });
    let failure: unknown;
    let settled!: () => void;
    const done = new Promise<void>((resolve) => settled = resolve);
    app.post("/", async (c) => {
      try {
        return c.text(
          reader === "readBytes"
            ? String((await c.readBytes()).length)
            : await c.req.text(),
        );
      } catch (error) {
        failure = error;
        throw error;
      } finally {
        settled();
      }
    });
    const { stream, cancelled } = stalled();
    const answer = await call(app, "/", { method: "POST", body: stream });
    assertStatus(answer, 504);
    await done;
    assertEquals(
      (failure as { name?: string }).name,
      "TimeoutError",
      `${reader} rejects with the timeout`,
    );
    assertEquals(cancelled.length, 1, `${reader} cancels the source`);
  }
});

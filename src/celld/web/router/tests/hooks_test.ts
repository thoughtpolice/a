// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

// The hooks around a route: `mapError`, `before`, and the context's
// `readBytes` and `accepts`; and `toPrincipal`.

import { assert, assertEquals, assertThrows } from "@celld/core/assert";
import {
  bearer,
  type Context,
  HttpError,
  middleware,
  router,
  RouterError,
  toPrincipal,
} from "@celld/web/router";
import { assertHeader, assertStatus, call, type Equal } from "./fixture.ts";

class UpstreamError extends Error {
  readonly kind = "upstream";
}

const upstream = (error: unknown) =>
  error instanceof UpstreamError
    ? Response.json({ kind: error.kind, error: error.message }, {
      status: 502,
    })
    : null;

Deno.test("mapError turns a thrown error into the answer", async () => {
  const reported: unknown[] = [];
  const app = router({
    auth: "none",
    onError: (error) => void reported.push(error),
  });
  app.get("/mapped", { mapError: upstream }, () => {
    throw new UpstreamError("the model is down");
  });
  app.get("/unmapped", () => {
    throw new UpstreamError("not mapped here");
  });
  const mapped = await call(app, "/mapped");
  assertStatus(mapped, 502);
  assertEquals(mapped.json, { kind: "upstream", error: "the model is down" });
  // It is still the router's answer: security headers and the request id.
  assertHeader(mapped, "x-content-type-options", "nosniff");
  assert(mapped.headers.get("x-request-id") !== null, "request id");
  // Mapped errors are not unexpected, so onError hears only the other one.
  const unmapped = await call(app, "/unmapped");
  assertStatus(unmapped, 500);
  assertEquals(reported.length, 1);
  assert(reported[0] instanceof UpstreamError, "the unmapped error");
});

Deno.test("mapError hooks run route first, then mounted, then serving router", async () => {
  const order: string[] = [];
  const hook = (name: string, answer = false) => (error: unknown) => {
    order.push(`${name}: ${(error as Error).message}`);
    return answer ? new Response(name, { status: 418 }) : undefined;
  };
  const child = router({ auth: "none", mapError: hook("child") });
  child.get("/x", { mapError: hook("route") }, () => {
    throw new Error("boom");
  });
  const app = router({ auth: "none", mapError: hook("app", true) })
    .mount("/c", child);
  app.get("/missing-handler-error", () => {
    throw new Error("top");
  });
  const answer = await call(app, "/c/x");
  assertEquals([answer.status, answer.text], [418, "app"]);
  assertEquals(order, ["route: boom", "child: boom", "app: boom"]);
  order.length = 0;
  // Errors outside any route (a 404 is an answer, not a throw) and routes
  // of the serving router get its hook.
  await call(app, "/missing-handler-error");
  assertEquals(order, ["app: top"]);
});

Deno.test("a mapError hook that throws replaces the error", async () => {
  const app = router({
    auth: "none",
    mapError: (error) => {
      if (error instanceof UpstreamError) {
        throw new HttpError(502, error.message, { expose: true });
      }
    },
  });
  app.get("/", () => {
    throw new UpstreamError("the model is down");
  });
  const answer = await call(app, "/");
  assertStatus(answer, 502);
  assertEquals(answer.json?.message, "the model is down");
});

Deno.test("a mapError hook sees HttpErrors and AuthErrors too, and may pass", async () => {
  const seen: string[] = [];
  const app = router({
    auth: "none",
    mapError: (error) => {
      seen.push((error as Error).name);
      return null;
    },
  });
  app.get("/", (c) => c.fail(409, "taken"));
  const answer = await call(app, "/");
  assertStatus(answer, 409);
  assertEquals(seen, ["HttpError"]);
});

Deno.test("before runs ahead of authentication", async () => {
  const seen: (string | null)[] = [];
  const noForeignOrigin = middleware(async (c, next) => {
    seen.push(c.principal?.subject ?? null);
    const origin = c.req.headers.get("origin");
    if (origin !== null && origin !== c.url.origin) {
      return c.json({ error: "origin not allowed" }, 403);
    }
    return await next();
  });
  const app = router({
    auth: bearer({ verify: ({ token }) => ({ subject: token }) }),
  });
  app.post("/mcp", {
    before: [noForeignOrigin],
    limits: { body: 4 },
  }, (c) => c.text(`hello ${c.principal.subject}`));
  // Without a credential, the foreign origin is refused before the 401.
  assertStatus(
    await call(app, "/mcp", {
      method: "POST",
      headers: { origin: "https://evil.example" },
    }),
    403,
  );
  assertStatus(await call(app, "/mcp", { method: "POST" }), 401);
  // Before the body limit, too.
  assertStatus(
    await call(app, "/mcp", {
      body: "too long",
      headers: { origin: "https://evil.example" },
    }),
    403,
  );
  const ok = await call(app, "/mcp", {
    method: "POST",
    headers: { authorization: "Bearer ada" },
  });
  assertEquals([ok.status, ok.text], [200, "hello ada"]);
  assertEquals(seen, [null, null, null, null]);
});

Deno.test("before middleware types the state", () => {
  const tagged = middleware<{ tag: string }>(async (c, next) => {
    c.state.tag = "t";
    return await next();
  });
  const app = router({ auth: "none" });
  app.get("/", { before: [tagged] }, (c) => {
    const _: Equal<typeof c.state.tag, string> = true;
    return c.text(c.state.tag);
  });
});

Deno.test("readBytes reads any body under the limit", async () => {
  const app = router({ auth: "none" });
  app.put("/blob", { limits: { body: 4 } }, async (c) => {
    const bytes = await c.readBytes();
    return c.json({ size: bytes.byteLength, first: bytes[0] });
  });
  const ok = await call(app, "/blob", {
    method: "PUT",
    body: new Uint8Array([7, 0, 255]),
    headers: { "content-type": "application/octet-stream" },
  });
  assertEquals(ok.json, { size: 3, first: 7 });
  assertStatus(
    await call(app, "/blob", { method: "PUT", body: "12345" }),
    413,
  );
  // A lying Content-Length does not get past the limit either.
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array(3));
      controller.enqueue(new Uint8Array(3));
      controller.close();
    },
  });
  const request = new Request("https://api.example.com/blob", {
    method: "PUT",
    body: stream,
    headers: { "content-length": "2" },
    duplex: "half",
  } as RequestInit);
  assertEquals((await app.fetch(request)).status, 413);
});

Deno.test("accepts negotiates the Accept header", async () => {
  const offered = ["application/json", "text/html"];
  const app = router({ auth: "none" });
  app.get("/", (c: Context) => c.text(String(c.accepts(...offered))));
  const pick = async (accept?: string) =>
    (await call(app, "/", {
      headers: accept === undefined ? {} : { accept },
    })).text;
  assertEquals(await pick(), "application/json");
  assertEquals(await pick("*/*"), "application/json");
  assertEquals(
    await pick(
      "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    ),
    "text/html",
  );
  assertEquals(await pick("text/*"), "text/html");
  assertEquals(await pick("text/html;q=0, */*"), "application/json");
  assertEquals(await pick("text/html;q=0"), "null");
  assertEquals(await pick("image/png"), "null");
  assertEquals(
    await pick("TEXT/HTML;Q=0.5, application/json;q=0.4"),
    "text/html",
  );
  // The most specific range sets a type's q, whatever the order.
  assertEquals(
    await pick("*/*;q=1, application/json;q=0.1, text/html;q=0.2"),
    "text/html",
  );
  // Malformed ranges and q-values are ignored.
  assertEquals(
    await pick("html, text/html;q=2, application/json"),
    "application/json",
  );
});

Deno.test("toPrincipal builds the principal the router would", () => {
  const principal = toPrincipal({
    subject: "ada",
    scopes: ["a"],
    headers: { "dpop-nonce": "n" },
  }, "test");
  assertEquals(principal, {
    subject: "ada",
    scopes: ["a"],
    roles: [],
    claims: {},
    scheme: "test",
    key: "test\u0000\u0000\u0000\u0000ada",
  });
  assert(
    Object.isFrozen(principal) && Object.isFrozen(principal.scopes),
    "frozen",
  );
  assertThrows(
    () => toPrincipal({ subject: "" }, "test"),
    TypeError,
    "without a subject",
  );
});

// DB-REV-RTR-5: `fetch` never rejects over a header. `c.header` checks its
// name and value at the call (inside the pipeline, so the error is an
// opaque 500 through `onError`), and router settings that become headers
// are checked when the router is made.
Deno.test("a header a handler cannot send is a 500 at c.header, and fetch still answers", async () => {
  const reported: unknown[] = [];
  const app = router({ auth: "none", onError: (e) => void reported.push(e) });
  app.get("/echo", (c) => {
    c.header("x-note", c.url.searchParams.get("n") ?? "");
    return c.text("ok");
  });
  app.get("/name", (c) => {
    c.header("bad name", "v");
    return c.text("ok");
  });
  for (const path of ["/echo?n=a%0D%0Ab", "/echo?n=a%00b", "/name"]) {
    const answer = await call(app, path);
    assertStatus(answer, 500);
    assert(answer.headers.get("x-request-id") !== null, "the request id");
    assertHeader(answer, "x-content-type-options", "nosniff");
  }
  assertEquals(reported.length, 3);
  assert(reported.every((e) => e instanceof TypeError), "TypeErrors");
  assertEquals((await call(app, "/echo?n=fine")).headers.get("x-note"), "fine");
});

Deno.test("settings that become headers are checked when the router is made", () => {
  for (const requestIdHeader of ["bad header", "", "x\r\ny"]) {
    assertThrows(
      () => router({ auth: "none", requestIdHeader }),
      RouterError,
      "requestIdHeader",
    );
  }
  for (const key of ["csp", "hsts", "frameOptions", "referrerPolicy"]) {
    assertThrows(
      () => router({ auth: "none", security: { [key]: "a\r\nb" } }),
      RouterError,
      `security.${key}`,
    );
  }
});

Deno.test("a request id a header cannot carry is replaced, and reported", async () => {
  const reported: unknown[] = [];
  const app = router({
    auth: "none",
    requestId: () => "id\r\nset-cookie: a=1",
    onError: (e) => void reported.push(e),
  });
  app.get("/", (c) => c.text(c.requestId));
  const answer = await call(app, "/");
  assertStatus(answer, 200);
  const id = answer.headers.get("x-request-id")!;
  assertEquals(answer.text, id);
  assert(/^[0-9A-Z]{26}$/.test(id), `a ULID instead: ${id}`);
  assertEquals(answer.headers.get("set-cookie"), null);
  assertEquals(reported.length, 1);
  const throwing = router({
    auth: "none",
    requestId: () => {
      throw new Error("no ids");
    },
  });
  throwing.get("/", (c) => c.text("ok"));
  assertStatus(await call(throwing, "/"), 200);
});

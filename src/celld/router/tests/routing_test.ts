// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

import { assert, assertEquals, assertThrows } from "@celld/assert";
import {
  type Middleware,
  middleware,
  router,
  RouterError,
} from "@celld/router";
import { assertHeader, assertMatch, assertStatus, call } from "./fixture.ts";

function open() {
  return router({ auth: "none" });
}

Deno.test("literal beats param beats wildcard, whatever the order added", async () => {
  const app = open();
  app.get("/files/*rest", (c) => c.json({ route: "wildcard", ...c.params }));
  app.get("/files/:name", (c) => c.json({ route: "param", ...c.params }));
  app.get("/files/readme", (c) => c.json({ route: "literal" }));
  assertEquals((await call(app, "/files/readme")).json, { route: "literal" });
  assertEquals((await call(app, "/files/other")).json, {
    route: "param",
    name: "other",
  });
  assertEquals((await call(app, "/files/a/b/c")).json, {
    route: "wildcard",
    rest: "a/b/c",
  });
});

Deno.test("matching backtracks from a literal that dead-ends", async () => {
  const app = open();
  app.get("/a/b/c", (c) => c.text("abc"));
  app.get("/a/:x/d", (c) => c.text(`x=${c.params.x}`));
  assertEquals((await call(app, "/a/b/d")).text, "x=b");
  assertEquals((await call(app, "/a/b/c")).text, "abc");
});

Deno.test("params are decoded per segment; an encoded slash stays in its segment", async () => {
  const app = open();
  app.get("/users/:id/posts/:post", (c) => c.json(c.params));
  assertEquals((await call(app, "/users/a%2Fb/posts/caf%C3%A9")).json, {
    id: "a/b",
    post: "café",
  });
  const bad = await call(app, "/users/%E0%A4%A/posts/1");
  assertStatus(bad, 400);
  assertMatch(bad.json, { error: "bad_request" });
});

Deno.test("a wildcard matches zero or more segments", async () => {
  const app = open();
  app.get("/static/*path", (c) => c.text(`[${c.params.path}]`));
  assertEquals((await call(app, "/static")).text, "[]");
  assertEquals((await call(app, "/static/")).text, "[]");
  assertEquals(
    (await call(app, "/static/css/site.css")).text,
    "[css/site.css]",
  );
});

Deno.test("routes are strict about trailing slashes and empty segments", async () => {
  const app = open();
  app.get("/users", (c) => c.text("list"));
  app.get("/users/:id", (c) => c.text(c.params.id));
  assertStatus(await call(app, "/users/"), 404);
  assertStatus(await call(app, "/users//x"), 404);
  assertEquals((await call(app, "/users")).text, "list");
});

Deno.test("the root route and the 404 body", async () => {
  const app = router({
    auth: "none",
    requestId: () => "01J0000000000000000000000A",
  });
  app.get("/", (c) => c.text("home"));
  assertEquals((await call(app, "/")).text, "home");
  const missing = await call(app, "/nope");
  assertStatus(missing, 404);
  assertEquals(missing.json, {
    error: "not_found",
    message: "no route matches this path",
    requestId: "01J0000000000000000000000A",
  });
});

Deno.test("405 lists every method of every matching route in Allow", async () => {
  const app = open();
  app.get("/users/me", (c) => c.text("me"));
  app.delete("/users/:id", (c) => c.text(`deleted ${c.params.id}`));
  app.put("/users/:id", (c) => c.text("put"));
  const post = await call(app, "/users/me", { method: "POST" });
  assertStatus(post, 405);
  assertHeader(post, "allow", "DELETE, GET, HEAD, OPTIONS, PUT");
  assertMatch(post.json, { error: "method_not_allowed" });
  const del = await call(app, "/users/me", { method: "DELETE" });
  assertEquals(
    del.text,
    "deleted me",
    "a lower-priority route with the method is used",
  );
});

Deno.test("HEAD is served by GET without a body; an explicit HEAD wins", async () => {
  const app = open();
  app.get("/doc", (c) => {
    c.header("x-seen", c.method);
    return c.text("body");
  });
  app.get("/other", (c) => c.text("get"));
  app.head("/other", () => new Response(null, { headers: { "x-head": "1" } }));
  const head = await call(app, "/doc", { method: "HEAD" });
  assertStatus(head, 200);
  assertEquals(head.text, "");
  assertHeader(head, "x-seen", "HEAD");
  assertHeader(head, "content-type", "text/plain; charset=utf-8");
  assertHeader(await call(app, "/other", { method: "HEAD" }), "x-head", "1");
});

Deno.test("OPTIONS answers 204 with Allow unless a route handles it", async () => {
  const app = open();
  app.get("/a", (c) => c.text("a"));
  app.post("/a", (c) => c.text("a"));
  app.get("/b", (c) => c.text("b"));
  app.options("/b", (c) => c.text("custom"));
  const auto = await call(app, "/a", { method: "OPTIONS" });
  assertStatus(auto, 204);
  assertHeader(auto, "allow", "GET, HEAD, OPTIONS, POST");
  assertEquals((await call(app, "/b", { method: "OPTIONS" })).text, "custom");
});

Deno.test("sub-routers mount under prefixes, with prefix params", async () => {
  const app = open();
  const orgs = open();
  orgs.get(
    "/",
    (c) => c.json({ org: (c.params as Record<string, string>).org }),
  );
  orgs.get("/members/:member", (c) => c.json(c.params));
  app.mount("/orgs/:org", orgs);
  assertEquals((await call(app, "/orgs/acme")).json, { org: "acme" });
  assertEquals((await call(app, "/orgs/acme/members/ada")).json, {
    org: "acme",
    member: "ada",
  });
  assertEquals(
    app.routes().map((r) => `${r.method} ${r.pattern}`),
    ["GET /orgs/:org", "GET /orgs/:org/members/:member"],
  );
});

Deno.test("middleware is an onion: router, mounted router, route", async () => {
  const log: string[] = [];
  const tag = (name: string): Middleware => async (_c, next) => {
    log.push(`>${name}`);
    const response = await next();
    log.push(`<${name}`);
    return response;
  };
  const app = open().use(tag("app"));
  const child = open().use(tag("child"));
  child.get("/x", { use: [tag("route")] }, (c) => {
    log.push("handler");
    return c.text("ok");
  });
  app.mount("/c", child);
  assertEquals((await call(app, "/c/x")).text, "ok");
  assertEquals(log, [
    ">app",
    ">child",
    ">route",
    "handler",
    "<route",
    "<child",
    "<app",
  ]);
  log.length = 0;
  assertStatus(await call(app, "/missing"), 404);
  assertEquals(
    log,
    [">app", "<app"],
    "404s go through the router's middleware",
  );
});

Deno.test("middleware can answer early and adds typed state", async () => {
  const stamp = middleware<{ stamp: string }>(async (c, next) => {
    if (c.req.headers.has("x-stop")) return c.text("stopped", 418);
    c.state.stamp = "s1";
    return await next();
  });
  const app = open().use(stamp);
  app.get("/", (c) => c.text(c.state.stamp));
  assertEquals((await call(app, "/")).text, "s1");
  assertStatus(await call(app, "/", { headers: { "x-stop": "1" } }), 418);
});

Deno.test("calling next() twice is an error (an opaque 500)", async () => {
  const app = open().use(async (_c, next) => {
    await next();
    return await next();
  });
  app.get("/", (c) => c.text("x"));
  const answer = await call(app, "/");
  assertStatus(answer, 500);
  assertMatch(answer.json, {
    error: "internal_error",
    message: "internal error",
  });
});

Deno.test("registration refuses bad patterns and collisions", () => {
  const app = open();
  app.get("/users/:id", (c) => c.text("x"));
  assertThrows(
    () => app.get("/users/:other", (c) => c.text("y")),
    RouterError,
    "collides",
  );
  assertThrows(
    () => app.get("users", (c) => c.text("y")),
    RouterError,
    'starts with "/"',
  );
  assertThrows(
    () => app.get("/a/", (c) => c.text("y")),
    RouterError,
    "trailing",
  );
  assertThrows(
    () => app.get("/a/*x/b", (c) => c.text("y")),
    RouterError,
    "last",
  );
  assertThrows(
    () => app.get("/a/:x/:x", (c) => c.text("y")),
    RouterError,
    "repeats",
  );
  assertThrows(
    () => app.get("/a/:1x", (c) => c.text("y")),
    RouterError,
    "bad parameter",
  );
  assertThrows(
    () => app.on("get", "/lower", {}, (c) => c.text("y")),
    RouterError,
    "upper-case",
  );
  app.on("PURGE", "/cache", {}, (c) => c.text("purged"));
});

Deno.test("custom methods route like any other", async () => {
  const app = open();
  app.on("PURGE", "/cache", {}, (c) => c.text("purged"));
  assertEquals((await call(app, "/cache", { method: "PURGE" })).text, "purged");
});

Deno.test("a mounted router is frozen and mounts once", () => {
  const app = open();
  const child = open();
  child.get("/x", (c) => c.text("x"));
  app.mount("/c", child);
  assertThrows(
    () => child.get("/y", (c) => c.text("y")),
    RouterError,
    "mounted",
  );
  assertThrows(() => open().mount("/d", child), RouterError, "already mounted");
  assertThrows(() => app.mount("/e/*x", open()), RouterError, "wildcard");
});

Deno.test("mounting a colliding route fails at mount and leaves the parent unchanged", () => {
  const app = open();
  app.get("/c/x", (c) => c.text("x"));
  const child = open();
  child.get("/x", (c) => c.text("y"));
  assertThrows(() => app.mount("/c", child), RouterError, "already routed");
  assertEquals(app.routes().length, 1);
});

Deno.test("the export shape works as a Worker default", async () => {
  const app = open();
  app.get("/", (c) => c.text("ok"));
  const worker = { fetch: app.fetch };
  const response = await worker.fetch(new Request("https://x.example/"));
  assert(response.ok, "ok");
});

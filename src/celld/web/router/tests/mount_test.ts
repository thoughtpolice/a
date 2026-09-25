// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

// DB-RTR-003 and DB-RTR-004: what mounting may combine. An inheriting
// router cannot turn into an anonymous one by being mounted under
// `auth: "none"`, and a mounted route cannot name a parameter its prefix
// already names.

import { assert, assertEquals, assertThrows } from "@celld/core/assert";
import {
  apiKey,
  bearer,
  router,
  RouterError,
  type RouterOptions,
  session,
} from "@celld/web/router";
import { assertStatus, call } from "./fixture.ts";

const tokens = bearer({
  verify: ({ token }) => token === "ada" ? { subject: "ada" } : null,
});

Deno.test('an inheriting router with private routes cannot mount under auth "none"', async () => {
  const app = router({ auth: "none" });
  const notes = router({ auth: "inherit" });
  notes.get("/", (c) => c.text(`secret for ${c.principal?.subject}`));
  assertThrows(
    () => app.mount("/notes", notes),
    RouterError,
    'GET /notes inherits auth from a router with auth "none"',
  );
  // Nothing was mounted: the path is still a 404.
  assertStatus(await call(app, "/notes"), 404);
});

Deno.test("the refusal reaches inheriting routers nested in inheriting routers", () => {
  const leaf = router({ auth: "inherit" });
  leaf.get("/x", (c) => c.text("x"));
  const middle = router({ auth: "inherit" });
  middle.mount("/leaf", leaf);
  const app = router({ auth: "none" });
  assertThrows(
    () => app.mount("/m", middle),
    RouterError,
    'GET /m/leaf/x inherits auth from a router with auth "none"',
  );
});

Deno.test('an inheriting router whose routes are all public mounts under auth "none"', async () => {
  const app = router({ auth: "none" });
  const docs = router({ auth: "inherit" });
  docs.get("/", { public: true }, (c) => c.text("docs"));
  app.mount("/docs", docs);
  assertEquals((await call(app, "/docs")).text, "docs");
});

Deno.test("an inheriting router under schemes still authenticates", async () => {
  const app = router({ auth: tokens });
  const notes = router({ auth: "inherit" });
  notes.get("/", (c) => c.text(`notes of ${c.principal?.subject}`));
  app.mount("/notes", notes);
  assertStatus(await call(app, "/notes"), 401);
  assertEquals(
    (await call(app, "/notes", { headers: { authorization: "Bearer ada" } }))
      .text,
    "notes of ada",
  );
});

Deno.test("a mounted route cannot repeat a prefix parameter name", async () => {
  const app = router({ auth: "none" });
  const users = router({ auth: "none" });
  users.get("/users/:id", (c) => c.json(c.params));
  assertThrows(
    () => app.mount("/orgs/:id", users),
    RouterError,
    "GET /orgs/:id/users/:id names the parameter id twice",
  );
  assertStatus(await call(app, "/orgs/1/users/2"), 404);
  assertEquals(app.routes().length, 0);
});

Deno.test("repeated parameter names are refused at any depth", () => {
  const leaf = router({ auth: "inherit" });
  leaf.get("/items/:org", { public: true }, (c) => c.text("x"));
  const middle = router({ auth: "inherit" });
  middle.mount("/teams/:team", leaf);
  const app = router({ auth: "none" });
  assertThrows(
    () => app.mount("/orgs/:org", middle),
    RouterError,
    "names the parameter org twice",
  );
  // A wildcard name counts too.
  const files = router({ auth: "none" });
  files.get("/*org", (c) => c.text("x"));
  assertThrows(
    () => router({ auth: "none" }).mount("/orgs/:org", files),
    RouterError,
    "names the parameter org twice",
  );
});

Deno.test("distinct names across the prefix and the route are fine", async () => {
  const app = router({ auth: "none" });
  const users = router({ auth: "none" });
  users.get("/users/:user", (c) => c.json(c.params));
  app.mount("/orgs/:org", users);
  assertEquals((await call(app, "/orgs/1/users/2")).json, {
    org: "1",
    user: "2",
  });
});

Deno.test("a router can declare its prefix parameters and read them typed", async () => {
  const app = router({ auth: "none" });
  const users = router<unknown, "org">({ auth: "none" });
  users.get("/users/:user", (c) => c.text(`${c.params.org}:${c.params.user}`));
  app.mount("/orgs/:org", users);
  assertEquals((await call(app, "/orgs/1/users/2")).text, "1:2");
});

// DB-REV-RTR-2: a mounted router's own settings would be ignored (the
// serving router's apply), so a router built with any of them cannot be
// mounted. `auth` and `mapError` are the ones a mounted router keeps.

Deno.test("a router with settings of its own cannot be mounted", async () => {
  const cases: [string, Omit<RouterOptions, "auth">][] = [
    ["limits", { limits: { body: 16 } }],
    ["csrf", { csrf: { token: true } }],
    ["csrf", { csrf: false }],
    ["security", { security: { frameOptions: "SAMEORIGIN" } }],
    ["clientIp", { clientIp: { peer: () => "10.0.0.1" } }],
    ["publicUrl", {
      publicUrl: { mode: "fixed", origin: "https://a.example" },
    }],
    ["cookies", { cookies: { sameSite: "Strict" } }],
    ["onError", { onError: () => {} }],
    ["requestId", { requestId: () => "id" }],
    ["requestIdHeader", { requestIdHeader: "x-id" }],
    ["cors", { cors: "passthrough" }],
    [
      "allowCleartextCredentialsForDevelopment",
      { allowCleartextCredentialsForDevelopment: true },
    ],
  ];
  for (const [name, options] of cases) {
    const child = router({ auth: "none", ...options });
    child.post("/upload", { csrf: false }, (c) => c.text("in"));
    const parent = router({ auth: "none" });
    assertThrows(() => parent.mount("/c", child), RouterError, name);
    // Nothing was mounted.
    assertStatus(await call(parent, "/c/upload", { method: "POST" }), 404);
  }
});

Deno.test("the audit's probe: a child's body limit and CSRF tokens are never silently dropped", async () => {
  const child = router({ auth: "none", limits: { body: 16 } });
  child.post(
    "/upload",
    { csrf: false },
    async (c) => c.text(`read ${(await c.readBytes()).length}`),
  );
  assertThrows(() => router({ auth: "none" }).mount("/c", child), RouterError);
  const sessions = session({
    keys: [{ id: "k1", secret: "0123456789abcdef0123456789abcdef" }],
  });
  const bank = router({ auth: sessions, csrf: { token: true } });
  bank.post("/transfer", (c) => c.text("moved"));
  assertThrows(
    () => router({ auth: "none" }).mount("/bank", bank),
    RouterError,
    "csrf",
  );
  // A route's own limits still travel with it, as a floor under the
  // serving router's.
  const small = router({ auth: "none" });
  small.post(
    "/upload",
    { csrf: false, limits: { body: 16 } },
    async (c) => c.text(`read ${(await c.readBytes()).length}`),
  );
  const parent = router({ auth: "none" });
  parent.mount("/c", small);
  assertStatus(
    await call(parent, "/c/upload", { method: "POST", body: "x".repeat(1000) }),
    413,
  );
});

Deno.test("auth and mapError are a mounted router's own", async () => {
  const child = router({
    auth: tokens,
    mapError: () => new Response("mapped", { status: 418 }),
  });
  child.get("/boom", () => {
    throw new Error("boom");
  });
  const app = router({ auth: "none" });
  app.mount("/c", child);
  const answer = await call(app, "/c/boom", {
    headers: { authorization: "Bearer ada" },
  });
  assertEquals([answer.status, answer.text], [418, "mapped"]);
});

// DB-REV-RTR-3: `Principal.key` starts with the scheme's name, so two
// different schemes of one name in one served tree would give their
// principals equal keys.

Deno.test("two different schemes with one name anywhere in the tree are refused", async () => {
  const customers = apiKey({
    lookup: (k) => k === "cust-key" ? { subject: "alice" } : null,
  });
  const staff = apiKey({
    lookup: (k) => k === "staff-key" ? { subject: "alice" } : null,
  });
  const admin = router({ auth: staff });
  admin.get("/whoami", (c) => c.json({ key: c.principal.key }));
  const app = router({ auth: customers });
  app.get("/whoami", (c) => c.json({ key: c.principal.key }));
  assertThrows(
    () => app.mount("/admin", admin),
    RouterError,
    "two different auth schemes are named apiKey",
  );
  assertStatus(await call(app, "/admin/whoami"), 404);
  // Deeper: the clash is found through an inheriting router in between.
  const middle = router({ auth: "inherit" });
  const leaf = router({ auth: apiKey({ lookup: () => null }) });
  leaf.get("/x", (c) => c.text("x"));
  middle.mount("/leaf", leaf);
  const top = router({ auth: customers });
  top.get("/", (c) => c.text("top"));
  assertThrows(() => top.mount("/m", middle), RouterError, "apiKey");
  // Renamed, the two populations have different keys.
  const renamed = router({
    auth: apiKey({
      name: "staffKey",
      lookup: (k) => k === "staff-key" ? { subject: "alice" } : null,
    }),
  });
  renamed.get("/whoami", (c) => c.json({ key: c.principal.key }));
  app.mount("/admin", renamed);
  const k1 = (await call(app, "/whoami", {
    headers: { "x-api-key": "cust-key" },
  })).json as { key: string };
  const k2 = (await call(app, "/admin/whoami", {
    headers: { "x-api-key": "staff-key" },
  })).json as { key: string };
  assert(k1.key !== k2.key, "different owners");
});

Deno.test("one scheme object used by a router and a mounted one is fine", async () => {
  const app = router({ auth: tokens });
  app.get("/a", (c) => c.text(c.principal.subject));
  const child = router({ auth: tokens });
  child.get("/b", (c) => c.text(c.principal.subject));
  app.mount("/c", child);
  const headers = { authorization: "Bearer ada" };
  assertEquals((await call(app, "/c/b", { headers })).text, "ada");
});

Deno.test("a scheme cannot name another scheme in its principal", async () => {
  const reported: unknown[] = [];
  const liar = bearer({
    verify: () => ({ subject: "alice", scheme: "apiKey" }),
  });
  const app = router({ auth: liar, onError: (e) => void reported.push(e) });
  app.get("/", (c) => c.text(c.principal.key));
  const answer = await call(app, "/", {
    headers: { authorization: "Bearer t" },
  });
  assertStatus(answer, 500);
  assert(
    String(reported[0]).includes("scheme"),
    `reported ${String(reported[0])}`,
  );
  // Its own name is allowed (and changes nothing).
  const honest = bearer({
    verify: () => ({ subject: "alice", scheme: "bearer" }),
  });
  const ok = router({ auth: honest });
  ok.get("/", (c) => c.text(c.principal.key));
  assertEquals(
    (await call(ok, "/", { headers: { authorization: "Bearer t" } })).text,
    "bearer\u0000\u0000\u0000\u0000alice",
  );
});

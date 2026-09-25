// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

import { assert, assertEquals } from "@celld/core/assert";
import { v } from "@celld/sieve";
import { bearer, HttpError, router } from "@celld/web/router";
import { createClient, defineRoute } from "@celld/web/router/client";

const routes = {
  lookup: defineRoute("GET", "/items/:id", {
    query: v.object({
      tags: v.array(v.string()),
      page: v.coerce.number().int(),
    }),
    response: v.object({
      id: v.string(),
      tags: v.array(v.string()),
      page: v.number(),
    }),
  }),
  create: defineRoute("POST", "/items", {
    body: v.object({ title: v.string().min(1) }),
    response: v.object({ title: v.string() }),
    responses: { 201: { description: "Created" } },
  }),
  remove: defineRoute("DELETE", "/items/:id", {
    responses: { 204: { description: "Deleted" } },
  }),
};

Deno.test("client: encoded params and repeated query values reach the registered handler", async () => {
  const app = router({ auth: "none" }).register(
    routes.lookup,
    (c) => c.json({ id: c.params.id, ...c.query }),
  );
  const client = createClient<typeof app>()({ lookup: routes.lookup }, {
    baseUrl: "https://example.test",
    fetch: (url, init) => app.fetch(new Request(url, init)),
  });
  const result = await client.call("lookup", {
    params: { id: "a/b ?#%" },
    query: { tags: ["a+b", "c&d"], page: "2" },
  });
  assert(result.ok, "lookup must succeed");
  assertEquals(result.status, 200);
  assertEquals(result.data, { id: "a/b ?#%", tags: ["a+b", "c&d"], page: 2 });
});

Deno.test("client: JSON body and declared 201 and 204 statuses remain distinct", async () => {
  const app = router({ auth: "none" })
    .register(routes.create, (c) => c.json(c.body, { status: 201 }))
    .register(routes.remove, (c) => c.empty());
  const client = createClient<typeof app>()({
    create: routes.create,
    remove: routes.remove,
  }, {
    baseUrl: "https://example.test",
    fetch: (url, init) => app.fetch(new Request(url, init)),
  });
  const made = await client.call("create", { body: { title: "A & B" } });
  assert(made.ok, "creation must succeed");
  assertEquals(made.status, 201);
  assertEquals(made.data, { title: "A & B" });
  const removed = await client.call("remove", { params: { id: "1" } });
  assert(removed.ok, "deletion must succeed");
  assertEquals(removed.status, 204);
  assertEquals(removed.data, undefined);
});

Deno.test("client: router validation errors preserve Sieve issues and field errors", async () => {
  const app = router({ auth: "none" }).register(
    routes.create,
    (c) => c.json(c.body, { status: 201 }),
  );
  const client = createClient<typeof app>()({ create: routes.create }, {
    baseUrl: "https://example.test",
    fetch: (url, init) => app.fetch(new Request(url, init)),
  });
  const result = await client.call("create", { body: { title: "" } });
  assert(
    !result.ok && result.kind === "validation",
    "invalid title must preserve validation details",
  );
  assertEquals(result.status, 400);
  assertEquals(result.error.location, "body");
  assertEquals(result.error.issues[0].path, ["title"]);
  assertEquals(result.error.issues[0].code, "too_small");
  assertEquals(result.error.fieldErrors.title, [
    result.error.issues[0].message,
  ]);
});

Deno.test("client: anonymous and forbidden answers retain auth codes and challenges", async () => {
  const secured = defineRoute("GET", "/private", {
    response: v.object({ value: v.string() }),
  });
  const app = router({
    auth: bearer({ verify: () => ({ subject: "reader", scopes: ["read"] }) }),
  })
    .register(
      secured,
      { scopes: ["write"] },
      (c) => c.json({ value: "secret" }),
    );
  const client = createClient<typeof app>()({ secured }, {
    baseUrl: "https://example.test",
    fetch: (url, init) => app.fetch(new Request(url, init)),
  });
  const anonymous = await client.call("secured", {});
  assert(
    !anonymous.ok && anonymous.kind === "auth",
    "anonymous request must be an auth failure",
  );
  assertEquals(anonymous.status, 401);
  assert(
    anonymous.challenge?.startsWith("Bearer"),
    "auth failure must retain its challenge",
  );
  const forbidden = await client.call("secured", {
    headers: { authorization: "Bearer token" },
  });
  assert(
    !forbidden.ok && forbidden.kind === "auth",
    "insufficient scope must be an auth failure",
  );
  assertEquals(forbidden.status, 403);
  assertEquals(forbidden.error.error, "insufficient_scope");
});

Deno.test("client: untrusted response and malformed error bodies fail Sieve validation", async () => {
  const endpoint = defineRoute("GET", "/", {
    response: v.object({ id: v.number() }),
  });
  const client = createClient({ endpoint }, {
    baseUrl: "https://example.test",
    fetch: () => Promise.resolve(Response.json({ id: "bad" })),
  });
  const success = await client.call("endpoint", {});
  assert(
    !success.ok && success.kind === "response",
    "invalid success data must fail response validation",
  );
  assertEquals(success.issues?.issues[0].path, ["id"]);
  const errors = createClient({ endpoint }, {
    baseUrl: "https://example.test",
    fetch: () =>
      Promise.resolve(
        Response.json({ error: "forbidden", message: 17 }, { status: 403 }),
      ),
  });
  const invalid = await errors.call("endpoint", {});
  assert(
    !invalid.ok && invalid.kind === "response",
    "invalid auth error data must fail response validation",
  );
  assertEquals(invalid.status, 403);
});

Deno.test("client: documented HTTP errors preserve the router envelope and schema", async () => {
  const endpoint = defineRoute("GET", "/conflict", {
    responses: {
      409: {
        description: "Conflict",
        schema: v.object({
          error: v.string(),
          message: v.string(),
          requestId: v.string(),
          version: v.number(),
        }),
      },
    },
  });
  const app = router({ auth: "none" }).register(endpoint, () => {
    throw new HttpError(409, "stale version", { details: { version: 4 } });
  });
  const client = createClient({ endpoint }, {
    baseUrl: "https://example.test",
    fetch: (url, init) => app.fetch(new Request(url, init)),
  });
  const result = await client.call("endpoint", {});
  assert(
    !result.ok && result.kind === "http",
    "conflict must retain its HTTP error",
  );
  assertEquals(result.status, 409);
  assertEquals(result.error.error, "conflict");
  assert(
    typeof result.data === "object" && result.data !== null &&
      "version" in result.data,
    "conflict data must remain available",
  );
  assertEquals(result.data.version, 4);
});

Deno.test("client: form arrays and encoded wildcard segments preserve the wire values", async () => {
  const endpoint = defineRoute("POST", "/files/*path", {
    bodyType: "form",
    body: v.object({ tags: v.array(v.string()) }),
    response: v.object({ path: v.string(), tags: v.array(v.string()) }),
  });
  const app = router({ auth: "none" }).register(
    endpoint,
    (c) => c.json({ path: c.params.path, tags: c.body.tags }),
  );
  const client = createClient({ endpoint }, {
    baseUrl: "https://example.test",
    fetch: (url, init) => app.fetch(new Request(url, init)),
  });
  const result = await client.call("endpoint", {
    params: { path: "a b/c?#" },
    body: { tags: ["a+b", "c&d"] },
  });
  assert(result.ok, "encoded form and wildcard request must succeed");
  assertEquals(result.data, { path: "a b/c?#", tags: ["a+b", "c&d"] });
});

Deno.test("client: cancellation and network failures are different from HTTP responses", async () => {
  const endpoint = defineRoute("GET", "/");
  const controller = new AbortController();
  controller.abort();
  const client = createClient({ endpoint }, {
    baseUrl: "https://example.test",
    fetch: (_url, init) =>
      Promise.reject(init?.signal?.reason ?? new TypeError("offline")),
  });
  const cancelled = await client.call("endpoint", {
    signal: controller.signal,
  });
  assert(
    !cancelled.ok && cancelled.kind === "cancelled",
    "abort must be distinct from transport failure",
  );
  const offline = await client.call("endpoint", {});
  assert(
    !offline.ok && offline.kind === "transport",
    "network failure must be reported",
  );
});

Deno.test("client: a dot parameter cannot silently address a different route", async () => {
  const endpoint = defineRoute("GET", "/items/:id");
  const client = createClient({ endpoint }, {
    baseUrl: "https://example.test",
    fetch: () => {
      throw new Error("must not send");
    },
  });
  const result = await client.call("endpoint", { params: { id: ".." } });
  assert(
    !result.ok && result.kind === "request",
    "dot path must not address a different route",
  );
});

// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

import { assert, assertEquals, assertThrows } from "@celld/core/assert";
import {
  apiKey,
  type AuthScheme,
  bearer,
  router,
  RouterError,
} from "@celld/web/router";
import { openapi } from "@celld/web/router/openapi";
import { v } from "@celld/sieve";
import { assertMatch, call } from "./fixture.ts";

const Note = v.object({ id: v.string(), text: v.string().min(1) }).meta({
  id: "Note",
});
const NewNote = v.object({
  text: v.string().min(1),
  tags: v.array(v.string()).default([]),
});

function app() {
  const app = router({
    auth: [
      bearer({ verify: () => null, bearerFormat: "JWT" }),
      apiKey({ lookup: () => null }),
    ],
  });
  app.get("/notes/:id", {
    scopes: ["notes:read"],
    summary: "Read a note",
    operationId: "getNote",
    tags: ["notes"],
    response: Note,
  }, (c) => c.json({ id: c.params.id, text: "x" }));
  app.post(
    "/notes",
    { scopes: ["notes:write"], body: NewNote, response: Note },
    (c) => c.json({ id: "1", text: c.body.text }, 201),
  );
  app.get("/search", {
    public: true,
    query: v.object({
      q: v.string(),
      limit: v.coerce.number().int().optional(),
    }),
  }, (c) => c.json(c.query));
  app.get("/openapi.json", { public: true }, (c) =>
    c.json(openapi(app, {
      info: { title: "Notes", version: "1.0.0" },
      exclude: (route) => route.pattern === "/openapi.json",
    })));
  return app;
}

Deno.test("paths, parameters, bodies, responses and security", () => {
  const doc = openapi(app(), {
    info: { title: "Notes", version: "1.0.0" },
    servers: [{ url: "https://api.example.com" }],
    exclude: (route) => route.pattern === "/openapi.json",
  });
  assertEquals(doc.openapi, "3.1.0");
  assertEquals(doc.servers, [{ url: "https://api.example.com" }]);
  const paths = doc.paths as Record<
    string,
    Record<string, Record<string, unknown>>
  >;
  assertEquals(Object.keys(paths), ["/notes/{id}", "/notes", "/search"]);

  const get = paths["/notes/{id}"].get;
  assertMatch(get, {
    operationId: "getNote",
    summary: "Read a note",
    tags: ["notes"],
    parameters: [{
      name: "id",
      in: "path",
      required: true,
      schema: { type: "string" },
    }],
    // DB-RTR-015: http and apiKey requirements carry no scopes (OpenAPI
    // gives scope lists to oauth2 and openIdConnect only); the route's
    // scopes are in the operation's `x-required-scopes`.
    security: [{ bearer: [] }, { apiKey: [] }],
    "x-required-scopes": ["notes:read"],
  });
  const responses = get.responses as Record<string, unknown>;
  assertEquals(Object.keys(responses), ["200", "401", "403"]);
  assertEquals(responses["200"], {
    description: "OK",
    content: {
      "application/json": { schema: { $ref: "#/components/schemas/Note" } },
    },
  });

  const post = paths["/notes"].post;
  assertEquals(post.requestBody, {
    required: true,
    content: {
      "application/json": {
        schema: {
          type: "object",
          properties: {
            text: { type: "string", minLength: 1 },
            tags: { type: "array", items: { type: "string" }, default: [] },
          },
          required: ["text"],
        },
      },
    },
  });

  const search = paths["/search"].get;
  assertEquals(search.security, [{}, { bearer: [] }, { apiKey: [] }]);
  assertEquals(search.parameters, [
    { name: "q", in: "query", required: true, schema: { type: "string" } },
    {
      name: "limit",
      in: "query",
      required: false,
      schema: { type: "integer" },
    },
  ]);

  const components = doc.components as Record<string, Record<string, unknown>>;
  assertEquals(components.securitySchemes, {
    bearer: { type: "http", scheme: "bearer", bearerFormat: "JWT" },
    apiKey: { type: "apiKey", in: "header", name: "x-api-key" },
  });
  assertEquals(Object.keys(components.schemas), ["Error", "Note"]);
});

Deno.test("an auth: none router has empty security", () => {
  const open = router({ auth: "none" });
  open.get("/", (c) => c.text("x"));
  const doc = openapi(open, { info: { title: "t", version: "1" } });
  const paths = doc.paths as Record<
    string,
    Record<string, Record<string, unknown>>
  >;
  assertEquals(paths["/"].get.security, []);
  assertEquals(
    (doc.components as Record<string, unknown>).securitySchemes,
    undefined,
  );
});

Deno.test("the document can be served by the router it describes", async () => {
  const answer = await call(app(), "/openapi.json");
  assertMatch(answer.json, { openapi: "3.1.0" });
});

// DB-RTR-015

type Doc = {
  paths: Record<string, Record<string, Record<string, unknown>>>;
  components: {
    schemas: Record<string, unknown>;
    securitySchemes?: Record<string, unknown>;
  };
};

function doc(app: Parameters<typeof openapi>[0]): Doc {
  return openapi(app, { info: { title: "t", version: "1" } }) as unknown as Doc;
}

Deno.test("oauth2 and openIdConnect requirements keep the route's scopes", () => {
  const oauth: AuthScheme = {
    name: "oauth",
    ambient: false,
    authenticate: () => null,
    openapi: {
      type: "oauth2",
      flows: {
        clientCredentials: {
          tokenUrl: "https://as.example.com/token",
          scopes: {},
        },
      },
    },
  };
  const app = router({ auth: [oauth, bearer({ verify: () => null })] });
  app.get("/a", { scopes: ["a:read"] }, (c) => c.text("x"));
  assertEquals(doc(app).paths["/a"].get.security, [
    { oauth: ["a:read"] },
    { bearer: [] },
  ]);
});

Deno.test("two different security schemes with one name are an error", () => {
  const app = router({
    auth: bearer({ verify: () => null, bearerFormat: "JWT" }),
  });
  app.get("/a", (c) => c.text("x"));
  const child = router({ auth: bearer({ verify: () => null }) });
  child.get("/b", (c) => c.text("x"));
  // DB-REV-RTR-3: the mount itself is refused now (their principals' keys
  // would collide), before any document is made.
  assertThrows(
    () => app.mount("/c", child),
    RouterError,
    "two different auth schemes are named bearer",
  );
  assertEquals(Object.keys(doc(app).paths), ["/a"]);
  // The same scheme twice is fine.
  const same = bearer({ verify: () => null });
  const once = router({ auth: same });
  once.get("/a", (c) => c.text("x"));
  const again = router({ auth: same });
  again.get("/b", (c) => c.text("x"));
  once.mount("/c", again);
  assertEquals(Object.keys(doc(once).components.securitySchemes ?? {}), [
    "bearer",
  ]);
});

Deno.test("templated paths that differ only in names are one OpenAPI path: an error", () => {
  const renamed = router({ auth: "none" });
  renamed.get("/users/:id", (c) => c.text("x"));
  renamed.delete("/users/:uid", (c) => c.text("x"));
  assertThrows(() => doc(renamed), RouterError, "/users/{id}");
  const wild = router({ auth: "none" });
  wild.get("/files/:path", (c) => c.text("x"));
  wild.get("/files/*path", (c) => c.text("x"));
  assertThrows(() => doc(wild), RouterError, "/files/{path}");
  const fine = router({ auth: "none" });
  fine.get("/users/:id", (c) => c.text("x"));
  fine.delete("/users/:id", (c) => c.text("x"));
  assertEquals(Object.keys(doc(fine).paths["/users/{id}"]), ["get", "delete"]);
});

Deno.test("responses come from the route, plus the errors the router itself answers", () => {
  const Item = v.object({ id: v.string() }).meta({ id: "Item" });
  const app = router({ auth: bearer({ verify: () => null }) });
  app.post("/items", {
    scopes: ["w"],
    body: v.object({ id: v.string() }),
    response: Item,
    responses: {
      201: { description: "Created" },
      409: { description: "Exists" },
    },
  }, (c) => c.json({ id: "1" }, 201));
  app.delete("/items/:id", {
    responses: { 204: { description: "Deleted" } },
  }, (c) => c.empty());
  app.get(
    "/items/:id",
    { public: true, response: Item },
    (c) => c.json({ id: c.params.id }),
  );
  const paths = doc(app).paths;
  const post = paths["/items"].post.responses as Record<
    string,
    Record<string, unknown>
  >;
  assertEquals(Object.keys(post), [
    "201",
    "400",
    "401",
    "403",
    "409",
    "413",
    "415",
  ]);
  assertEquals(post["201"], {
    description: "Created",
    content: {
      "application/json": { schema: { $ref: "#/components/schemas/Item" } },
    },
  });
  assertEquals(post["409"].description, "Exists");
  const del = paths["/items/{id}"].delete.responses as Record<string, unknown>;
  assertEquals(Object.keys(del), ["204", "401"]);
  assertEquals(del["204"], { description: "Deleted" });
  const get = paths["/items/{id}"].get.responses as Record<string, unknown>;
  assertEquals(Object.keys(get), ["200", "401"]);
  for (
    const responses of [
      { "2xx": { description: "x" } },
      { 200: { description: 7 } },
      { 200: "OK" },
      { 99: { description: "x" } },
      { 200: { description: "x", schema: {} } },
    ]
  ) {
    assertThrows(
      () =>
        router({ auth: "none" }).get(
          "/",
          { responses: responses as never },
          (c) => c.text("x"),
        ),
      RouterError,
      "responses",
    );
  }
});

Deno.test("named query and path schemas are expanded into parameters", () => {
  const Search = v.object({ q: v.string(), page: v.coerce.number().optional() })
    .meta({ id: "Search" });
  const Path = v.object({ id: v.string().min(3) }).meta({ id: "ItemPath" });
  const app = router({ auth: "none" });
  app.get("/items/:id", { query: Search, params: Path }, (c) => c.text("x"));
  const { paths, components } = doc(app);
  assertEquals(paths["/items/{id}"].get.parameters, [
    {
      name: "id",
      in: "path",
      required: true,
      schema: { type: "string", minLength: 3 },
    },
    { name: "q", in: "query", required: true, schema: { type: "string" } },
    { name: "page", in: "query", required: false, schema: { type: "number" } },
  ]);
  assert("Search" in components.schemas, "the named schema is a component");
});

Deno.test("component names are validated and kept as own keys", () => {
  const proto = v.object({ a: v.string() }).meta({ id: "__proto__" });
  const app = router({ auth: "none" });
  app.get("/p", { response: proto }, (c) => c.json({ a: "x" }));
  const { components, paths } = doc(app);
  assert(Object.hasOwn(components.schemas, "__proto__"), "an own key");
  assertEquals(
    (paths["/p"].get.responses as Record<string, Record<string, unknown>>)[
      "200"
    ]
      .content,
    {
      "application/json": {
        schema: { $ref: "#/components/schemas/__proto__" },
      },
    },
  );
  assert(
    JSON.stringify(components.schemas).includes('"__proto__":{'),
    "serialized",
  );
  for (const id of ["a/b~c", "a b", ""]) {
    const bad = router({ auth: "none" });
    bad.get("/p", { response: v.object({}).meta({ id }) }, (c) => c.json({}));
    assertThrows(() => doc(bad), RouterError, "name");
  }
  const spaced: AuthScheme = {
    name: "my scheme",
    ambient: false,
    authenticate: () => null,
  };
  assertThrows(() => router({ auth: spaced }), RouterError, "name");
});

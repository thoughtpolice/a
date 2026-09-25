// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

import { assertEquals } from "@celld/assert";
import { apiKey, bearer, router } from "@celld/router";
import { openapi } from "@celld/router/openapi";
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
    security: [{ bearer: ["notes:read"] }, { apiKey: ["notes:read"] }],
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

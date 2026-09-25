// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

import { assert, assertEquals, assertThrows } from "@celld/assert";
import { HttpError, router, RouterError, scanJson } from "@celld/router";
import { v } from "@celld/sieve";
import { assertHeader, assertMatch, assertStatus, call } from "./fixture.ts";

const Note = v.object({
  title: v.string().min(1),
  tags: v.array(v.string()).max(3).default([]),
});

function app() {
  const app = router({ auth: "none", requestId: () => "RID" });
  app.post("/notes", { body: Note }, (c) => c.json(c.body, 201));
  app.get("/search", {
    query: v.object({
      q: v.string(),
      limit: v.coerce.number().int().max(50).default(10),
      tag: v.array(v.string()).optional(),
    }),
  }, (c) => c.json(c.query));
  app.get("/items/:id", {
    params: v.object({ id: v.coerce.number().int().positive() }),
  }, (c) => c.json({ id: c.params.id, type: typeof c.params.id }));
  return app;
}

Deno.test("a valid body is parsed, defaults applied, unknown keys stripped", async () => {
  const answer = await call(app(), "/notes", {
    json: { title: "hi", extra: true },
  });
  assertStatus(answer, 201);
  assertEquals(answer.json, { title: "hi", tags: [] });
});

Deno.test("an invalid body is a 400 with the flattened issues", async () => {
  const answer = await call(app(), "/notes", {
    json: { title: "", tags: ["a", "b", "c", "d"] },
  });
  assertStatus(answer, 400);
  assertEquals(answer.json, {
    error: "validation_failed",
    message: "the body is not valid",
    requestId: "RID",
    location: "body",
    formErrors: [],
    fieldErrors: {
      title: ["must have at least 1 character"],
      tags: ["must have at most 3 items"],
    },
    issues: [
      {
        path: ["title"],
        code: "too_small",
        message: "must have at least 1 character",
      },
      { path: ["tags"], code: "too_big", message: "must have at most 3 items" },
    ],
  });
});

Deno.test("a body that is not an object is a form error", async () => {
  const answer = await call(app(), "/notes", { json: [1] });
  assertStatus(answer, 400);
  assertMatch(answer.json, { formErrors: ["expected object, received array"] });
});

Deno.test("Content-Type is enforced (415), including a missing one", async () => {
  const wrong = await call(app(), "/notes", {
    body: '{"title":"x"}',
    headers: { "content-type": "text/plain" },
  });
  assertStatus(wrong, 415);
  assertMatch(wrong.json, {
    error: "unsupported_media_type",
    message: "expected an application/json body, got text/plain",
  });
  assertHeader(wrong, "accept-post", "application/json");
  const none = await call(app(), "/notes", {
    method: "POST",
    body: new Blob(['{"title":"x"}']),
  });
  assertStatus(none, 415);
  const vendor = await call(app(), "/notes", {
    body: '{"title":"x"}',
    headers: { "content-type": "application/vnd.api+json; charset=utf-8" },
  });
  assertStatus(vendor, 201);
});

Deno.test("invalid JSON is a 400", async () => {
  const answer = await call(app(), "/notes", {
    body: "{nope",
    headers: { "content-type": "application/json" },
  });
  assertStatus(answer, 400);
  assertMatch(answer.json, { error: "invalid_json" });
});

Deno.test("bodies over the limit are 413: by Content-Length, before reading", async () => {
  const small = router({ auth: "none", limits: { body: 16 } });
  let ran = false;
  small.post("/x", { body: v.unknown() }, (c) => {
    ran = true;
    return c.text("x");
  });
  const answer = await call(small, "/x", {
    json: { title: "this is long enough" },
  });
  assertStatus(answer, 413);
  assertMatch(answer.json, {
    error: "payload_too_large",
    message: "the body is larger than 16 bytes",
  });
  assert(!ran, "the handler never ran");
});

Deno.test("bodies over the limit are 413 while streaming, whatever Content-Length says", async () => {
  const small = router({ auth: "none", limits: { body: 16 } });
  small.post("/x", { body: v.unknown() }, (c) => c.text("x"));
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('{"a":"'));
      controller.enqueue(new TextEncoder().encode("x".repeat(64)));
      controller.enqueue(new TextEncoder().encode('"}'));
      controller.close();
    },
  });
  const answer = await call(small, "/x", {
    method: "POST",
    body: stream,
    headers: { "content-type": "application/json" },
  });
  assertStatus(answer, 413);
});

Deno.test("a route can raise its own body limit", async () => {
  const small = router({ auth: "none", limits: { body: 16 } });
  small.post(
    "/big",
    { body: v.unknown(), limits: { body: 1024 } },
    (c) => c.text("ok"),
  );
  assertStatus(
    await call(small, "/big", { json: { title: "this is long enough" } }),
    200,
  );
});

Deno.test("deep nesting and too many keys are refused before parsing", async () => {
  const strict = router({
    auth: "none",
    limits: { jsonDepth: 4, jsonKeys: 3 },
  });
  strict.post("/x", { body: v.unknown() }, (c) => c.text("ok"));
  const deep = await call(strict, "/x", {
    body: "[[[[[1]]]]]",
    headers: { "content-type": "application/json" },
  });
  assertStatus(deep, 400);
  assertMatch(deep.json, { error: "json_too_deep" });
  const wide = await call(strict, "/x", { json: { a: 1, b: 2, c: 3, d: 4 } });
  assertStatus(wide, 400);
  assertMatch(wide.json, { error: "json_too_many_keys" });
  assertStatus(await call(strict, "/x", { json: { a: "[[[[[:::::" } }), 200);
});

Deno.test("scanJson ignores brackets and colons inside strings, escapes included", () => {
  scanJson('{"a":"\\"[[[[:"}', 1, 1);
  const error = assertThrows(() => scanJson('{"a":{"b":1}}', 1, 10));
  assert(error instanceof HttpError && error.status === 400, "too deep");
});

Deno.test("query: typed and coerced; repeated names are lists", async () => {
  assertEquals((await call(app(), "/search?q=cats&limit=5")).json, {
    q: "cats",
    limit: 5,
  });
  assertEquals((await call(app(), "/search?q=cats&tag=a")).json, {
    q: "cats",
    limit: 10,
    tag: ["a"],
  });
  assertEquals((await call(app(), "/search?q=c&tag=a&tag=b")).json, {
    q: "c",
    limit: 10,
    tag: ["a", "b"],
  });
  const repeated = await call(app(), "/search?q=a&q=b");
  assertStatus(repeated, 400);
  assertMatch(repeated.json, {
    location: "query",
    fieldErrors: { q: ["expected string, received array"] },
  });
  const missing = await call(app(), "/search?limit=99");
  assertStatus(missing, 400);
  assertMatch(missing.json, {
    fieldErrors: {
      q: ["missing required key"],
      limit: ["must be at most 50"],
    },
  });
});

Deno.test("an unvalidated query is a record of strings and lists", async () => {
  const plain = router({ auth: "none" });
  plain.get("/", (c) => c.json(c.query));
  assertEquals((await call(plain, "/?a=1&b=2&b=3")).json, {
    a: "1",
    b: ["2", "3"],
  });
});

Deno.test("params: parsed by their schema", async () => {
  assertEquals((await call(app(), "/items/42")).json, {
    id: 42,
    type: "number",
  });
  const bad = await call(app(), "/items/-3");
  assertStatus(bad, 400);
  assertMatch(bad.json, { location: "path" });
});

Deno.test("form bodies: parsed, lists for repeated fields, 415 for JSON", async () => {
  const forms = router({ auth: "none" });
  forms.post("/f", {
    bodyType: "form",
    body: v.object({ name: v.string(), pick: v.array(v.string()) }),
  }, (c) => c.json(c.body));
  const answer = await call(forms, "/f", {
    body: "name=Ada&pick=x",
    headers: { "content-type": "application/x-www-form-urlencoded" },
  });
  assertEquals(answer.json, { name: "Ada", pick: ["x"] });
  assertStatus(await call(forms, "/f", { json: { name: "x", pick: [] } }), 415);
});

Deno.test("a response schema strips what it does not list", async () => {
  const api = router({ auth: "none" });
  const Public = v.object({ id: v.string(), name: v.string() });
  api.get(
    "/u",
    { response: Public },
    (c) =>
      c.json(
        { id: "1", name: "Ada", passwordHash: "x" } as {
          id: string;
          name: string;
        },
      ),
  );
  assertEquals((await call(api, "/u")).json, { id: "1", name: "Ada" });
});

Deno.test("a response that fails its schema is a 500, reported", async () => {
  const reported: unknown[] = [];
  const api = router({
    auth: "none",
    onError: (error) => void reported.push(error),
  });
  api.get(
    "/u",
    { response: v.object({ id: v.string() }) },
    (c) => c.json({ id: 1 } as unknown as { id: string }),
  );
  api.get(
    "/e",
    { response: v.object({ id: v.string() }) },
    (c) => c.json({ error: "nope" } as unknown as { id: string }, 404),
  );
  const answer = await call(api, "/u");
  assertStatus(answer, 500);
  assertEquals(reported.length, 1);
  assertStatus(await call(api, "/e"), 404);
});

Deno.test("GET routes cannot declare a body", () => {
  const api = router({ auth: "none" });
  assertThrows(
    () => api.get("/x", { body: Note }, (c) => c.text("x")),
    RouterError,
    "cannot have a body",
  );
});

Deno.test("readJson and readText honour the limits without a schema", async () => {
  const api = router({ auth: "none", limits: { body: 8 } });
  api.post("/json", async (c) => c.json(await c.readJson()));
  api.post("/text", async (c) => c.text(await c.readText()));
  assertEquals((await call(api, "/json", { json: [1, 2] })).json as unknown, [
    1,
    2,
  ]);
  assertStatus(
    await call(api, "/json", {
      body: "[1]",
      headers: { "content-type": "text/plain" },
    }),
    415,
  );
  assertStatus(await call(api, "/text", { body: "0123456789" }), 413);
});

// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * A JSON CRUD API for bookmarks: sieve validation, a KV store, per-route
 * scopes and an OpenAPI document generated from the routes.
 *
 * Callers send `Authorization: Bearer <token>`. The generic `bearer`
 * scheme hands each token to a verifier, which looks up its SHA-256 in
 * `API_TOKENS` (a JSON object from hash to principal), so the Worker holds
 * no usable token. Reads need `bookmarks:read`, writes
 * `bookmarks:write`; each caller sees only their own bookmarks.
 *
 * - `GET /openapi.json`: the OpenAPI 3.1 document (public).
 * - `GET /bookmarks?tag=&limit=`: the caller's bookmarks.
 * - `POST /bookmarks`: `{url, title, tags?}`, 201 with the bookmark; its
 *   id is the request's ULID.
 * - `GET`, `PUT`, `DELETE /bookmarks/:id`: one bookmark, by ULID.
 *
 * Bodies are limited to 4 KiB (413), must be JSON (415) and must parse
 * (400 with the issues by field). URLs must be http(s), so a stored
 * `javascript:` link cannot come back out. Responses go through their
 * schema, which drops the stored `owner` field.
 *
 * ```sh
 * buck2 run root//src/celld/router/examples:crud-dev
 * curl -sS localhost:9876/openapi.json
 * curl -sS localhost:9876/bookmarks -H 'authorization: Bearer bm_writer_3e8a5d1c6b7f9e21' \
 *   -H 'content-type: application/json' -d '{"url":"https://example.com","title":"Example"}'
 * ```
 *
 * @module
 */

import {
  bearer,
  hashApiKey,
  HttpError,
  type PrincipalInput,
  router,
} from "@celld/router";
import { openapi } from "@celld/router/openapi";
import { v } from "@celld/sieve";

interface Env {
  readonly BOOKMARKS: KVNamespace;
  /** `{"<sha256 of token>": {"subject": ..., "scopes": [...]}}` */
  readonly API_TOKENS: string;
}

const Bookmark = v.object({
  id: v.string().ulid(),
  url: v.string(),
  title: v.string(),
  tags: v.array(v.string()),
  created: v.string(),
}).meta({ id: "Bookmark" });

const NewBookmark = v.object({
  url: v.string().url().regex(/^https?:\/\//, "must be an http or https URL"),
  title: v.string().trim().min(1).max(200),
  tags: v.array(v.string().min(1).max(32)).max(8).default([]),
}).meta({ id: "NewBookmark" });

const ById = v.object({ id: v.string().ulid() });

type Stored = v.Infer<typeof Bookmark> & { readonly owner: string };

let tokens: {
  readonly env: Env;
  readonly table: ReadonlyMap<string, PrincipalInput>;
} | undefined;

function tokenTable(env: Env): ReadonlyMap<string, PrincipalInput> {
  if (tokens?.env !== env) {
    tokens = {
      env,
      table: new Map(Object.entries(JSON.parse(env.API_TOKENS))),
    };
  }
  return tokens.table;
}

const app = router<Env>({
  auth: bearer({
    realm: "bookmarks",
    verify: async ({ token, context }) =>
      tokenTable(context.env).get(await hashApiKey(token)) ?? null,
  }),
  limits: { body: 4096 },
});

const key = (owner: string, id: string) => `bookmark:${owner}:${id}`;

async function load(env: Env, owner: string, id: string): Promise<Stored> {
  const found = await env.BOOKMARKS.get<Stored>(key(owner, id), "json");
  if (found === null) throw new HttpError(404, "no such bookmark");
  return found;
}

app.get("/openapi.json", { public: true }, (c) =>
  c.json(openapi(app, {
    info: { title: "Bookmarks", version: "1.0.0" },
    exclude: (route) => route.pattern === "/openapi.json",
  })));

app.get("/bookmarks", {
  scopes: ["bookmarks:read"],
  summary: "List bookmarks",
  query: v.object({
    tag: v.string().optional(),
    limit: v.coerce.number().int().min(1).max(100).default(20),
  }),
  response: v.object({ bookmarks: v.array(Bookmark) }),
}, async (c) => {
  const owner = c.principal.subject;
  const { keys } = await c.env.BOOKMARKS.list({ prefix: `bookmark:${owner}:` });
  const all = await Promise.all(
    keys.map((entry) => c.env.BOOKMARKS.get<Stored>(entry.name, "json")),
  );
  const bookmarks = all.filter((b): b is Stored => b !== null)
    .filter((b) => c.query.tag === undefined || b.tags.includes(c.query.tag))
    .slice(0, c.query.limit);
  return c.json({ bookmarks });
});

app.post("/bookmarks", {
  scopes: ["bookmarks:write"],
  summary: "Add a bookmark",
  body: NewBookmark,
  response: Bookmark,
}, async (c) => {
  const bookmark: Stored = {
    id: c.requestId,
    ...c.body,
    created: new Date().toISOString(),
    owner: c.principal.subject,
  };
  await c.env.BOOKMARKS.put(
    key(bookmark.owner, bookmark.id),
    JSON.stringify(bookmark),
  );
  return c.json(bookmark, 201);
});

app.get("/bookmarks/:id", {
  scopes: ["bookmarks:read"],
  params: ById,
  response: Bookmark,
}, async (c) => c.json(await load(c.env, c.principal.subject, c.params.id)));

app.put("/bookmarks/:id", {
  scopes: ["bookmarks:write"],
  params: ById,
  body: NewBookmark,
  response: Bookmark,
}, async (c) => {
  const current = await load(c.env, c.principal.subject, c.params.id);
  const next: Stored = { ...current, ...c.body };
  await c.env.BOOKMARKS.put(key(next.owner, next.id), JSON.stringify(next));
  return c.json(next);
});

app.delete("/bookmarks/:id", {
  scopes: ["bookmarks:write"],
  params: ById,
}, async (c) => {
  await load(c.env, c.principal.subject, c.params.id);
  await c.env.BOOKMARKS.delete(key(c.principal.subject, c.params.id));
  return c.empty();
});

export default { fetch: app.fetch };

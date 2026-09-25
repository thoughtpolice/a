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
 * `bookmarks:write`; each caller sees only their own bookmarks, which are
 * stored under a domain-separated HMAC of the principal's `key`, never its `subject`
 * (see the router README). `API_TOKENS` is set by the spec's `vars` for
 * `celld dev` (public example tokens); unset, every token is refused.
 *
 * - `GET /openapi.json`: the OpenAPI 3.1 document (public), generated
 *   once when the module loads, after every route is registered, and
 *   served as the same frozen text on every request.
 * - `GET /bookmarks?tag=&limit=&cursor=`: a page of the caller's bookmarks
 *   (at most `limit`, 100 at most, read from KV; `tag` filters that page)
 *   and the `cursor` of the next page, or null.
 * - `POST /bookmarks`: `{url, title, tags?}`, 201 with the bookmark; its
 *   id is the request's ULID.
 * - `GET`, `PUT`, `DELETE /bookmarks/:id`: one bookmark, by ULID.
 *
 * KV has no conditional write and is eventually consistent, so `PUT` is a
 * read then a blind write: a `PUT` racing a `DELETE` of the same bookmark
 * can write it back after the `DELETE` answered 204, and of two `PUT`s the
 * last wins. That is acceptable for bookmarks; data whose updates must not
 * be lost or resurrected belongs in a Durable Object or D1, with a
 * conditional update (`UPDATE ... WHERE id = ? AND owner = ? AND version =
 * ?`, 404 or 412 when no row changed).
 *
 * Bodies are limited to 4 KiB (413), must be JSON (415) and must parse
 * (400 with the issues by field). URLs must be http(s), so a stored
 * `javascript:` link cannot come back out. Responses go through their
 * schema, which drops the stored `owner` field.
 *
 * There is no quota: a token holder can store as many bookmarks as KV
 * takes. A per-owner cap cannot be kept in KV, which has no atomic
 * counter (a `get` then `put` lets concurrent writes pass together); a
 * deployment that needs one counts in a Durable Object per owner, which
 * inserts only while the owner is under the cap, in one step.
 *
 * ```sh
 * buck2 run root//src/celld/web/router/examples:crud-dev
 * curl -sS 127.0.0.1:9876/openapi.json
 * curl -sS 127.0.0.1:9876/bookmarks -H 'authorization: Bearer bm_writer_DBfccclRLZ3nnhxcOCxshHIZ_86cRR1P96TGwV4Yj6g' \
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
} from "@celld/web/router";
import { openapi } from "@celld/web/router/openapi";
import { v } from "@celld/sieve";
import { opaqueIdentity } from "@celld/core/bounds";

interface Env {
  readonly IDENTITY_SECRET: string;
  readonly BOOKMARKS: KVNamespace;
  /** `{"<sha256 of token>": {"subject": ..., "scopes": [...]}}` */
  readonly API_TOKENS?: string;
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
      table: new Map(
        env.API_TOKENS === undefined
          ? []
          : Object.entries(JSON.parse(env.API_TOKENS)),
      ),
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

/**
 * The owner of what a principal stores: the keyed digest of its `key`, which
 * names the scheme, issuer and subject together, as hex (the key itself
 * holds NULs).
 */
const ownerOf = (principal: { readonly key: string }, env: Env) =>
  opaqueIdentity(
    new TextEncoder().encode(env.IDENTITY_SECRET),
    "router.bookmarks.owner",
    principal.key,
  );

async function load(env: Env, owner: string, id: string): Promise<Stored> {
  const found = await env.BOOKMARKS.get<Stored>(key(owner, id), "json");
  if (found === null) throw new HttpError(404, "no such bookmark");
  return found;
}

// Serves `DOCUMENT`, made below once every route is registered.
app.get("/openapi.json", { public: true }, () =>
  new Response(DOCUMENT, {
    headers: { "content-type": "application/json" },
  }));

app.get("/bookmarks", {
  scopes: ["bookmarks:read"],
  summary: "List bookmarks",
  query: v.object({
    tag: v.string().optional(),
    limit: v.coerce.number().int().min(1).max(100).default(20),
    cursor: v.string().max(1024).optional(),
  }),
  response: v.object({
    bookmarks: v.array(Bookmark),
    cursor: v.string().nullable(),
  }),
}, async (c) => {
  const owner = await ownerOf(c.principal, c.env);
  const listed = await c.env.BOOKMARKS.list({
    prefix: `bookmark:${owner}:`,
    limit: c.query.limit,
    cursor: c.query.cursor,
  });
  const page = await Promise.all(
    listed.keys.map((entry) => c.env.BOOKMARKS.get<Stored>(entry.name, "json")),
  );
  const bookmarks = page.filter((b): b is Stored => b !== null)
    .filter((b) => c.query.tag === undefined || b.tags.includes(c.query.tag));
  return c.json({
    bookmarks,
    cursor: listed.list_complete ? null : listed.cursor,
  });
});

app.post("/bookmarks", {
  scopes: ["bookmarks:write"],
  summary: "Add a bookmark",
  body: NewBookmark,
  response: Bookmark,
  responses: { 201: { description: "The bookmark, with its id" } },
}, async (c) => {
  const bookmark: Stored = {
    id: c.requestId,
    ...c.body,
    created: new Date().toISOString(),
    owner: await ownerOf(c.principal, c.env),
  };
  await c.env.BOOKMARKS.put(
    key(bookmark.owner, bookmark.id),
    JSON.stringify(bookmark),
  );
  return c.json(bookmark, 201);
});

app.get(
  "/bookmarks/:id",
  {
    scopes: ["bookmarks:read"],
    params: ById,
    response: Bookmark,
  },
  async (c) =>
    c.json(await load(c.env, await ownerOf(c.principal, c.env), c.params.id)),
);

app.put("/bookmarks/:id", {
  scopes: ["bookmarks:write"],
  params: ById,
  body: NewBookmark,
  response: Bookmark,
}, async (c) => {
  const current = await load(
    c.env,
    await ownerOf(c.principal, c.env),
    c.params.id,
  );
  const next: Stored = { ...current, ...c.body };
  // Not atomic with the load (see the module doc): a concurrent DELETE can
  // be undone by this put.
  await c.env.BOOKMARKS.put(key(next.owner, next.id), JSON.stringify(next));
  return c.json(next);
});

app.delete("/bookmarks/:id", {
  scopes: ["bookmarks:write"],
  params: ById,
  responses: { 204: { description: "Deleted" } },
}, async (c) => {
  const owner = await ownerOf(c.principal, c.env);
  await load(c.env, owner, c.params.id);
  await c.env.BOOKMARKS.delete(key(owner, c.params.id));
  return c.empty();
});

// Once, after the last route: the routes cannot change any more (a route
// added later would be missing from it), and no request pays for it.
const DOCUMENT: string = JSON.stringify(openapi(app, {
  info: { title: "Bookmarks", version: "1.0.0" },
  exclude: (route) => route.pattern === "/openapi.json",
}));

export default { fetch: app.fetch };

// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * A JSON API that validates what it is sent, and says everything wrong at
 * once.
 *
 * `POST /users` reads its body under a 4 KiB cap (413 over it) with
 * `@celld/core/bounds`, then parses it with a sieve schema: the username is
 * trimmed and lower-cased before its checks run, the email must be one,
 * `plan` defaults to `free`, and `tags` to `[]`. A body with problems gets a
 * 400 with `SieveError.flatten()`: `fieldErrors` by field, `formErrors` for
 * the body as a whole, every problem at once rather than the first.
 *
 * Whether the username is taken is an async refinement that asks the
 * name's `Username` Durable Object, so the route uses `safeParseAsync`.
 * Refinements run only on a value that passed every other check, so the
 * lookup never sees a malformed name. The refinement is only the friendly
 * early answer: two signups for one name can both pass it. The name is
 * claimed by one `INSERT OR IGNORE` in that object, which exactly one of
 * them wins; the other gets the same "is taken" 400. A KV `get` then `put`
 * cannot do this, since KV has no atomic check-and-set, so KV holds only
 * the user records, keyed by id.
 *
 * A new user gets a ULID `id`. `GET /users/<id>` parses the path segment
 * with `UserId`, an upper-cased `ulid()` string branded as `UserId`, so code past that point
 * cannot be handed an unchecked string where a user id belongs.
 *
 * The routes are unauthenticated on purpose (a signup form): anyone can
 * create users and read any user by id.
 *
 * ```sh
 * buck2 run root//src/celld/sieve/examples:signup-dev
 * curl -sS -X POST localhost:9876/users -d '{"username": " Ada ", "email": "ada@example.com"}'
 * curl -sS -X POST localhost:9876/users -d '{"username": "x", "email": "nope"}'
 * ```
 *
 * @module
 */

import { DurableObject } from "cloudflare:workers";
import {
  BoundsError,
  bytes,
  parseJsonBounded,
  readTextBounded,
} from "@celld/core/bounds";
import { type Infer, v } from "@celld/sieve";
import { ulid } from "@celld/core/ulid";

interface Env {
  readonly USERS: KVNamespace;
  readonly USERNAMES: DurableObjectNamespace<Username>;
}

/** One username (the object's name): who, if anyone, holds it. */
export class Username extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS holder (one INTEGER PRIMARY KEY CHECK (one = 1), id TEXT NOT NULL)",
    );
  }

  /** Whether the name is held. */
  async taken(): Promise<boolean> {
    const rows = this.ctx.storage.sql.exec("SELECT id FROM holder").toArray();
    return await Promise.resolve(rows.length > 0);
  }

  /**
   * Gives the name to `id`: true for the first call, false for every later
   * one. One statement, so of concurrent calls exactly one wins.
   */
  async claim(id: string): Promise<boolean> {
    const { rowsWritten } = this.ctx.storage.sql.exec(
      "INSERT OR IGNORE INTO holder (one, id) VALUES (1, ?)",
      id,
    );
    return await Promise.resolve(rowsWritten > 0);
  }
}

const MAX_BODY_BYTES = 4 * 1024;

const UserId = v.string().toUpperCase().ulid("not a user id").brand<"UserId">();
type UserId = Infer<typeof UserId>;

const Signup = v.strictObject({
  username: v.string().trim().toLowerCase().min(3).max(20).regex(
    /^[a-z][a-z0-9_]*$/,
    "use a letter, then letters, digits and underscores",
  ),
  email: v.email(),
  plan: v.enum(["free", "team", "enterprise"]).default("free"),
  tags: v.array(v.string().min(1)).max(5).default([]),
});

type User = Infer<typeof Signup> & { readonly id: UserId };

/** `Signup`, plus the refinement that needs this request's bindings. */
function signup(env: Env) {
  return Signup.refine(
    async ({ username }) => !(await env.USERNAMES.getByName(username).taken()),
    { message: "is taken", path: ["username"] },
  );
}

const TAKEN = { formErrors: [], fieldErrors: { username: ["is taken"] } };

async function create(request: Request, env: Env): Promise<Response> {
  const body = parseJsonBounded(
    await readTextBounded(request, { maxBytes: bytes(MAX_BODY_BYTES) }),
    { maxDepth: 4, maxKeys: 16, maxItems: 16 },
  );
  const parsed = await signup(env).safeParseAsync(body);
  if (!parsed.success) {
    return Response.json(parsed.error.flatten(), { status: 400 });
  }
  const user: User = { ...parsed.data, id: ulid() as UserId };
  if (!(await env.USERNAMES.getByName(user.username).claim(user.id))) {
    return Response.json(TAKEN, { status: 400 });
  }
  await env.USERS.put(`id:${user.id}`, JSON.stringify(user));
  return Response.json(user, { status: 201 });
}

async function lookup(id: UserId, env: Env): Promise<Response> {
  const stored = await env.USERS.get(`id:${id}`);
  return stored === null
    ? Response.json({ error: "no such user" }, { status: 404 })
    : new Response(stored, { headers: { "content-type": "application/json" } });
}

async function route(request: Request, env: Env): Promise<Response> {
  const { pathname } = new URL(request.url);
  if (request.method === "POST" && pathname === "/users") {
    return await create(request, env);
  }
  const match = /^\/users\/([^/]+)$/.exec(pathname);
  if (request.method === "GET" && match !== null) {
    const id = UserId.safeParse(match[1]);
    if (!id.success) {
      return Response.json(id.error.flatten(), { status: 400 });
    }
    return await lookup(id.data, env);
  }
  return Response.json({ error: "not found" }, { status: 404 });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    try {
      return await route(request, env);
    } catch (error) {
      if (!(error instanceof BoundsError)) throw error;
      // Over the cap, or JSON that is broken, too deep or too wide.
      return error.code === "too_large"
        ? Response.json({ error: "too_large" }, { status: 413 })
        : Response.json({ error: "invalid_json", message: error.message }, {
          status: 400,
        });
    }
  },
};

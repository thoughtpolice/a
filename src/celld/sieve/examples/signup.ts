// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * A JSON API that validates what it is sent, and says everything wrong at
 * once.
 *
 * `POST /users` parses its body with a sieve schema: the username is
 * trimmed and lower-cased before its checks run, the email must be one,
 * `plan` defaults to `free`, and `tags` to `[]`. A body with problems gets a
 * 400 with `SieveError.flatten()`: `fieldErrors` by field, `formErrors` for
 * the body as a whole, every problem at once rather than the first.
 *
 * Whether the username is taken is an async refinement that reads KV, so
 * the route uses `safeParseAsync`. Refinements run only on a value that
 * passed every other check, so the lookup never sees a malformed name.
 *
 * A new user gets a ULID `id`. `GET /users/<id>` parses the path segment
 * with `UserId`, an upper-cased `ulid()` string branded as `UserId`, so code past that point
 * cannot be handed an unchecked string where a user id belongs.
 *
 * ```sh
 * buck2 run root//src/celld/sieve/examples:signup-dev
 * curl -sS -X POST localhost:9876/users -d '{"username": " Ada ", "email": "ada@example.com"}'
 * curl -sS -X POST localhost:9876/users -d '{"username": "x", "email": "nope"}'
 * ```
 *
 * @module
 */

import { type Infer, v } from "@celld/sieve";
import { ulid } from "@celld/ulid";

interface Env {
  readonly USERS: KVNamespace;
}

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

/** `Signup`, plus the refinement that needs this request's KV. */
function signup(env: Env) {
  return Signup.refine(
    async ({ username }) => await env.USERS.get(`name:${username}`) === null,
    { message: "is taken", path: ["username"] },
  );
}

async function create(request: Request, env: Env): Promise<Response> {
  const body = await request.json().catch(() => undefined);
  const parsed = await signup(env).safeParseAsync(body);
  if (!parsed.success) {
    return Response.json(parsed.error.flatten(), { status: 400 });
  }
  const user: User = { ...parsed.data, id: ulid() as UserId };
  await env.USERS.put(`name:${user.username}`, user.id);
  await env.USERS.put(`id:${user.id}`, JSON.stringify(user));
  return Response.json(user, { status: 201 });
}

async function lookup(id: UserId, env: Env): Promise<Response> {
  const stored = await env.USERS.get(`id:${id}`);
  return stored === null
    ? Response.json({ error: "no such user" }, { status: 404 })
    : new Response(stored, { headers: { "content-type": "application/json" } });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
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
  },
};

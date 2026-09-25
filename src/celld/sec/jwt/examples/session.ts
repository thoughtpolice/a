// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * Login sessions in an HS256-signed cookie.
 *
 * `POST /login` with `{"user", "password"}` checks the password and sets a
 * `session` cookie holding a JWT signed with `SESSION_SECRET` (base64url,
 * at least 32 bytes: `verify` refuses a shorter HS256 secret). The token
 * carries the user, their role, a ULID `jti` and an expiry `SESSION_TTL`
 * from now, an ISO 8601 duration such as `PT1H`, which also becomes the
 * cookie's `Max-Age`.
 *
 * `GET /me` verifies the cookie with a verifier made once per isolate by
 * `createVerifier` (the secret is imported once): HS256 only (so a token
 * cannot pick another algorithm, `none` included), this issuer and
 * audience, and `exp`, `sub` and `jti` present; its `claims` function
 * turns the claims into a `Session` or refuses them. Each failure is a 401
 * naming the `JwtError` code.
 * `POST /logout` records the `jti` as revoked in KV until the token would
 * have expired anyway, and clears the cookie; a revoked token is refused
 * even though its signature is still good. KV is eventually consistent:
 * other locations can go on accepting the token for about a minute after
 * the logout. Where that matters, keep the revocations in a Durable
 * Object instead.
 *
 * A login body is read under a 4 KiB cap (413 beyond it). The users are a
 * stand-in for a real user store; never keep plain-text passwords. The
 * password is compared in constant time, over SHA-256 digests.
 *
 * ```sh
 * buck2 run root//src/celld/sec/jwt/examples:session-dev
 * curl -sS -c jar -X POST localhost:9876/login -d '{"user": "alice", "password": "wonderland"}'
 * curl -sS -b jar localhost:9876/me
 * ```
 *
 * @module
 */

import { BoundsError, bytes, readTextBounded } from "@celld/core/bounds";
import { parseDuration } from "@celld/core/isotime";
import {
  createVerifier,
  fromBase64Url,
  type JwtClaims,
  JwtError,
  type JwtVerifier,
  sign,
} from "@celld/sec/jwt";
import { ulid } from "@celld/core/ulid";

interface Env {
  readonly SESSION_SECRET: string;
  readonly SESSION_TTL: string;
  readonly REVOKED: KVNamespace;
}

interface Session {
  readonly sub: string;
  readonly role: string;
  readonly jti: string;
  readonly exp: number;
}

const ISSUER = "jwt-example-session";
const USERS: Record<string, { password: string; role: string }> = {
  alice: { password: "wonderland", role: "admin" },
  bob: { password: "builder", role: "member" },
};

function secret(env: Env): Uint8Array {
  const bytes = fromBase64Url(env.SESSION_SECRET);
  if (bytes === null) throw new Error("SESSION_SECRET is not base64url");
  return bytes;
}

/** The claims as a `Session`, or a throw (`invalid_claim`). */
function sessionClaims(claims: JwtClaims): Session {
  const { sub, role, jti, exp } = claims;
  if (
    typeof sub !== "string" || typeof role !== "string" ||
    typeof jti !== "string" || typeof exp !== "number"
  ) {
    throw new TypeError("not a session");
  }
  return { sub, role, jti, exp };
}

let prepared: { secret: string; verifier: JwtVerifier<Session> } | undefined;

/** The session verifier, made once per isolate (and per secret). */
function sessions(env: Env): JwtVerifier<Session> {
  if (prepared?.secret !== env.SESSION_SECRET) {
    prepared = {
      secret: env.SESSION_SECRET,
      verifier: createVerifier({
        keys: secret(env),
        algorithms: ["HS256"],
        issuer: ISSUER,
        audience: ISSUER,
        requiredClaims: ["exp", "sub", "jti"],
        claims: sessionClaims,
      }),
    };
  }
  return prepared.verifier;
}

function ttlSeconds(env: Env): number {
  const ttl = parseDuration(env.SESSION_TTL);
  if (ttl === null) throw new Error(`SESSION_TTL is not a duration`);
  // `total` refuses weeks, months and years, which have no fixed length.
  return Math.floor(ttl.total("seconds"));
}

function cookie(request: Request, name: string): string | null {
  for (const pair of (request.headers.get("cookie") ?? "").split(";")) {
    const [key, ...value] = pair.trim().split("=");
    if (key === name) return value.join("=");
  }
  return null;
}

function refuse(error: string): Response {
  return Response.json({ error }, { status: 401 });
}

async function session(
  request: Request,
  env: Env,
): Promise<Session | Response> {
  const token = cookie(request, "session");
  if (token === null || token === "") return refuse("no_session");
  try {
    const { payload } = await sessions(env).verify(token);
    if (await env.REVOKED.get(payload.jti) !== null) return refuse("revoked");
    return payload;
  } catch (error) {
    if (error instanceof JwtError) return refuse(error.code);
    throw error;
  }
}

async function digest(text: string): Promise<Uint8Array> {
  return new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)),
  );
}

/** Whether two strings are equal, in time that does not depend on them. */
async function sameText(a: string, b: string): Promise<boolean> {
  const [x, y] = await Promise.all([digest(a), digest(b)]);
  let difference = 0;
  for (let i = 0; i < x.length; i++) difference |= x[i] ^ y[i];
  return difference === 0;
}

/** The login body: at most 4 KiB of JSON, `{}` when it is not JSON. */
async function credentials(
  request: Request,
): Promise<{ user?: unknown; password?: unknown }> {
  const text = await readTextBounded(request, { maxBytes: bytes(4096) });
  try {
    const body: unknown = JSON.parse(text);
    return typeof body === "object" && body !== null ? body : {};
  } catch {
    return {};
  }
}

async function login(request: Request, env: Env): Promise<Response> {
  const { user, password } = await credentials(request);
  const account = typeof user === "string" && Object.hasOwn(USERS, user)
    ? USERS[user]
    : undefined;
  if (
    typeof user !== "string" || account === undefined ||
    typeof password !== "string" ||
    !(await sameText(account.password, password))
  ) {
    return refuse("bad_credentials");
  }
  const ttl = ttlSeconds(env);
  const now = Date.now();
  const token = await sign(
    { sub: user, role: account.role, jti: ulid(now), iss: ISSUER, aud: ISSUER },
    secret(env),
    { alg: "HS256", issuedAt: true, expiresIn: ttl, now },
  );
  const exp = Math.floor(now / 1000) + ttl;
  return Response.json({
    user,
    role: account.role,
    expires: Temporal.Instant.fromEpochMilliseconds(exp * 1000).toString(),
  }, {
    headers: {
      "set-cookie":
        `session=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${ttl}`,
    },
  });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const route = `${request.method} ${new URL(request.url).pathname}`;
    if (route === "POST /login") {
      try {
        return await login(request, env);
      } catch (error) {
        if (error instanceof BoundsError && error.code === "too_large") {
          return Response.json({ error: "too_large" }, { status: 413 });
        }
        throw error;
      }
    }
    if (route === "GET /me" || route === "POST /logout") {
      const current = await session(request, env);
      if (current instanceof Response) return current;
      if (route === "GET /me") {
        return Response.json({
          user: current.sub,
          role: current.role,
          expires: Temporal.Instant.fromEpochMilliseconds(current.exp * 1000)
            .toString(),
        });
      }
      // Remember the revocation only as long as the token could be used
      // (KV refuses an expiration less than 60 seconds ahead).
      const soonest = Math.floor(Date.now() / 1000) + 60;
      await env.REVOKED.put(current.jti, "logout", {
        expiration: Math.max(current.exp, soonest),
      });
      return new Response(null, {
        status: 204,
        headers: {
          "set-cookie":
            "session=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0",
        },
      });
    }
    return Response.json({ error: "not found" }, { status: 404 });
  },
};

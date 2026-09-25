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
 * `GET /me` verifies the cookie: HS256 only (so a token cannot pick another
 * algorithm, `none` included), this issuer and audience, and `exp`, `sub`
 * and `jti` present. Each failure is a 401 naming the `JwtError` code.
 * `POST /logout` records the `jti` as revoked in KV until the token would
 * have expired anyway, and clears the cookie; a revoked token is refused
 * even though its signature is still good.
 *
 * The users are a stand-in for a real user store; never keep plain-text
 * passwords.
 *
 * ```sh
 * buck2 run root//src/celld/jwt/examples:session-dev
 * curl -sS -c jar -X POST localhost:9876/login -d '{"user": "alice", "password": "wonderland"}'
 * curl -sS -b jar localhost:9876/me
 * ```
 *
 * @module
 */

import { parseDuration } from "@celld/isotime";
import { fromBase64Url, JwtError, sign, verify } from "@celld/jwt";
import { ulid } from "@celld/ulid";

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
    const { payload } = await verify<Session & Record<string, unknown>>(
      token,
      secret(env),
      {
        algorithms: ["HS256"],
        issuer: ISSUER,
        audience: ISSUER,
        requiredClaims: ["exp", "sub", "jti"],
      },
    );
    if (await env.REVOKED.get(payload.jti) !== null) return refuse("revoked");
    return payload;
  } catch (error) {
    if (error instanceof JwtError) return refuse(error.code);
    throw error;
  }
}

async function login(request: Request, env: Env): Promise<Response> {
  const { user, password } = await request.json().catch(() => ({})) as {
    user?: unknown;
    password?: unknown;
  };
  const account = typeof user === "string" && Object.hasOwn(USERS, user)
    ? USERS[user]
    : undefined;
  if (
    typeof user !== "string" || account === undefined ||
    typeof password !== "string" || account.password !== password
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
    if (route === "POST /login") return await login(request, env);
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
      // Remember the revocation only as long as the token could be used.
      await env.REVOKED.put(current.jti, "logout", { expiration: current.exp });
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

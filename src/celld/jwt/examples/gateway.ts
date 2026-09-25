// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * An API gateway that verifies OAuth access tokens against the issuer's
 * JWKS, fetched with `RemoteJwks`.
 *
 * One origin serves both halves: `POST /oauth/token` is forwarded to the
 * authorization server (`TOKEN_URL`), and `/api/*` requires
 * `Authorization: Bearer <token>`, verified here without calling the
 * issuer. A token must be ES256 (the issuer's algorithm; a token cannot
 * pick HS256 and have the public key used as its secret), `typ` `at+jwt`,
 * from `ISSUER`, for `AUDIENCE`, and unexpired, with 30 seconds of clock
 * skew allowed.
 *
 * `RemoteJwks` lives for the isolate: it fetches `JWKS_URL` once and keeps
 * the set for ten minutes. A token whose `kid` it does not have makes it
 * fetch again, which is how a key rotation reaches it, but at most once per
 * `JWKS_COOLDOWN_MS`, so tokens with made-up `kid`s cannot turn every
 * request into a fetch.
 *
 * - `GET /api/whoami` returns the token's subject, scope and `kid`.
 * - `GET /api/reports` also needs the `reports:read` scope (else 403).
 *
 * Failures are 401 with a `WWW-Authenticate: Bearer` challenge (RFC 6750)
 * whose `error_description` is the `JwtError` code.
 *
 * ```sh
 * buck2 run root//src/celld/jwt/examples:gateway-dev
 * TOKEN=$(curl -sS -X POST localhost:9876/oauth/token -d '{"client_id": "cli"}' | jq -r .access_token)
 * curl -sS localhost:9876/api/whoami -H "authorization: Bearer $TOKEN"
 * ```
 *
 * @module
 */

import { type JwtClaims, JwtError, RemoteJwks, verify } from "@celld/jwt";

interface Env {
  readonly ISSUER: string;
  readonly AUDIENCE: string;
  readonly JWKS_URL: string;
  readonly TOKEN_URL: string;
  readonly JWKS_COOLDOWN_MS: string;
}

let issuerKeys: RemoteJwks | undefined;

function jwks(env: Env): RemoteJwks {
  if (issuerKeys?.url.href !== new URL(env.JWKS_URL).href) {
    issuerKeys = new RemoteJwks(env.JWKS_URL, {
      cooldownMs: Number(env.JWKS_COOLDOWN_MS),
    });
  }
  return issuerKeys;
}

function challenge(status: 401 | 403, error: string, description?: string) {
  const params = [`realm="api"`];
  if (error !== "") params.push(`error="${error}"`);
  if (description !== undefined) {
    params.push(`error_description="${description}"`);
  }
  return Response.json({ error: description ?? (error || "unauthorized") }, {
    status,
    headers: { "www-authenticate": `Bearer ${params.join(", ")}` },
  });
}

async function authenticate(
  request: Request,
  env: Env,
): Promise<{ claims: JwtClaims; kid: unknown } | Response> {
  const token = /^Bearer (\S+)$/.exec(
    request.headers.get("authorization") ?? "",
  )
    ?.[1];
  if (token === undefined) return challenge(401, "");
  try {
    const { payload, header } = await verify(token, jwks(env), {
      algorithms: ["ES256"],
      typ: "at+jwt",
      issuer: env.ISSUER,
      audience: env.AUDIENCE,
      requiredClaims: ["exp", "sub"],
      clockTolerance: 30,
    });
    return { claims: payload, kid: header.kid };
  } catch (error) {
    if (error instanceof JwtError) {
      return challenge(401, "invalid_token", error.code);
    }
    throw error;
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const { pathname } = new URL(request.url);
    if (request.method === "POST" && pathname === "/oauth/token") {
      return await fetch(env.TOKEN_URL, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: await request.text(),
      });
    }
    if (!pathname.startsWith("/api/")) {
      return Response.json({ error: "not found" }, { status: 404 });
    }
    const caller = await authenticate(request, env);
    if (caller instanceof Response) return caller;
    const { claims, kid } = caller;
    const scopes = typeof claims.scope === "string"
      ? claims.scope.split(" ")
      : [];
    if (pathname === "/api/whoami") {
      return Response.json({ sub: claims.sub, scopes, kid });
    }
    if (pathname === "/api/reports") {
      if (!scopes.includes("reports:read")) {
        return challenge(403, "insufficient_scope", "reports:read");
      }
      return Response.json({ reports: ["q3-revenue"] });
    }
    return Response.json({ error: "not found" }, { status: 404 });
  },
};

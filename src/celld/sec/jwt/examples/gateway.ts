// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * An API gateway that verifies OAuth access tokens against the issuer's
 * JWKS, fetched with `RemoteJwks`.
 *
 * One origin serves both halves: `POST /oauth/token` is relayed to the
 * authorization server (`TOKEN_URL`), and `/api/*` requires
 * `Authorization: Bearer <token>`, verified here without calling the
 * issuer. A token must be ES256 (the issuer's algorithm; a token cannot
 * pick HS256 and have the public key used as its secret), `typ` `at+jwt`,
 * from `ISSUER`, for `AUDIENCE`, and unexpired, with 30 seconds of clock
 * skew allowed.
 *
 * The relay reads at most 16 KiB of the request (413 beyond it), sends it
 * with no redirects and a 5 second deadline, reads at most 64 KiB of the
 * answer, and answers with its status and body only, marked `no-store`;
 * anything else is a 502.
 *
 * The verifier is made once per isolate with `createVerifier` over a
 * `RemoteJwks`: it fetches `JWKS_URL` once and keeps the set for five
 * minutes, or less when the JWKS response's `Cache-Control` `max-age` is
 * shorter (never less than the cooldown): that is what lets an issuer
 * publish a key before signing with it and know every verifier has it.
 * A token whose `kid` it does not have makes it fetch again, which
 * is how a key rotation reaches it, but at most once per
 * `JWKS_COOLDOWN_MS`, so tokens with made-up `kid`s cannot turn every
 * request into a fetch. The fetch is bounded (`https:` to a public host,
 * no redirects, 5 seconds, 256 KiB); `JWKS_LOOPBACK_FOR_DEVELOPMENT=true`
 * allows the `http://127.0.0.1` fake issuer the example runs against, and
 * never belongs in production.
 *
 * - `GET /api/whoami` returns the token's subject, scope and `kid`.
 * - `GET /api/reports` also needs the `reports:read` scope (else 403).
 *
 * A bad credential is a 401 with a `WWW-Authenticate: Bearer` challenge
 * (RFC 6750) whose `error_description` is the `JwtError` code. The server's
 * own failures are not the client's: keys that cannot be fetched (`jwks`)
 * are a 503 with `Retry-After`, and a runtime that cannot check the token
 * (`runtime_unsupported`) or any other error is a 500.
 *
 * ```sh
 * buck2 run root//src/celld/sec/jwt/examples:gateway-dev
 * TOKEN=$(curl -sS -X POST localhost:9876/oauth/token -d '{"client_id": "cli"}' | jq -r .access_token)
 * curl -sS localhost:9876/api/whoami -H "authorization: Bearer $TOKEN"
 * ```
 *
 * @module
 */

import { BoundsError, bytes, readTextBounded } from "@celld/core/bounds";
import {
  createVerifier,
  type JwtClaims,
  JwtError,
  type JwtVerifier,
  RemoteJwks,
} from "@celld/sec/jwt";

interface Env {
  readonly ISSUER: string;
  readonly AUDIENCE: string;
  readonly JWKS_URL: string;
  readonly TOKEN_URL: string;
  readonly JWKS_COOLDOWN_MS: string;
  readonly JWKS_LOOPBACK_FOR_DEVELOPMENT?: string;
}

let prepared: { config: string; verifier: JwtVerifier } | undefined;

/** The access token verifier, made once per isolate (and per config). */
function tokens(env: Env): JwtVerifier {
  const config = JSON.stringify([
    env.JWKS_URL,
    env.ISSUER,
    env.AUDIENCE,
    env.JWKS_COOLDOWN_MS,
    env.JWKS_LOOPBACK_FOR_DEVELOPMENT,
  ]);
  if (prepared?.config !== config) {
    const keys = new RemoteJwks(env.JWKS_URL, {
      maxAgeMs: 300_000,
      cooldownMs: Number(env.JWKS_COOLDOWN_MS),
      allowLoopbackForDevelopment: env.JWKS_LOOPBACK_FOR_DEVELOPMENT === "true",
    });
    prepared = {
      config,
      verifier: createVerifier({
        keys,
        algorithms: ["ES256"],
        typ: "at+jwt",
        issuer: env.ISSUER,
        audience: env.AUDIENCE,
        requiredClaims: ["exp", "sub"],
        clockTolerance: 30,
      }),
    };
  }
  return prepared.verifier;
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
    const { payload, header } = await tokens(env).verify(token);
    return { claims: payload, kid: header.kid };
  } catch (error) {
    if (!(error instanceof JwtError) || error.code === "runtime_unsupported") {
      // The server cannot check tokens: its problem, not the client's.
      console.error("token verification failed", error);
      return Response.json({ error: "server_error" }, { status: 500 });
    }
    if (error.code === "jwks") {
      return Response.json({ error: "temporarily_unavailable" }, {
        status: 503,
        headers: { "retry-after": "5" },
      });
    }
    return challenge(401, "invalid_token", error.code);
  }
}

/**
 * Relays a token request: a bounded body out, no redirects (the request
 * carries client credentials), a deadline, and a bounded answer back.
 */
async function relayToken(request: Request, env: Env): Promise<Response> {
  let body: string;
  try {
    body = await readTextBounded(request, { maxBytes: bytes(16 * 1024) });
  } catch (error) {
    if (error instanceof BoundsError && error.code === "too_large") {
      return Response.json({ error: "too_large" }, { status: 413 });
    }
    return Response.json({ error: "invalid_request" }, { status: 400 });
  }
  try {
    const answer = await fetch(env.TOKEN_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
      redirect: "error",
      signal: AbortSignal.timeout(5_000),
    });
    const text = await readTextBounded(answer, {
      maxBytes: bytes(64 * 1024),
    });
    return new Response(text, {
      status: answer.status,
      headers: {
        "content-type": "application/json",
        "cache-control": "no-store",
      },
    });
  } catch (error) {
    console.error("token relay failed", error);
    return Response.json({ error: "bad_gateway" }, { status: 502 });
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const { pathname } = new URL(request.url);
    if (request.method === "POST" && pathname === "/oauth/token") {
      return await relayToken(request, env);
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

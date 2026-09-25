// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * A token issuer with its own keys, rotation and a JWKS endpoint.
 *
 * The signing keys live in a `SigningKeys` Durable Object: generated with
 * `generateKeyPair` on first use, stored as JWKs in its SQLite, and named by
 * their RFC 7638 thumbprint (`jwkThumbprint`), so a `kid` is stable and says
 * which key it is. The algorithm is the `SIGNING_ALG` variable, `ES256` or
 * `EdDSA`. This example uses ES256: celld 0.5.1 signs with Ed25519, but
 * its WebCrypto cannot verify Ed25519 yet, so introspection (and any
 * verifier running on celld) would refuse every EdDSA token.
 *
 * - `POST /token` with `{"sub", "scope"?}` issues an access token (`typ`
 *   `at+jwt`, RFC 9068) for `AUDIENCE`, valid for `TOKEN_TTL` (an ISO 8601
 *   duration), with a ULID `jti`. Put your own client authentication in
 *   front of it.
 * - `GET /.well-known/jwks.json` publishes the public keys, and never a
 *   private member.
 * - `POST /rotate` makes a new current key. The previous one stays in the
 *   JWKS, so tokens it signed verify until they expire; older ones go.
 * - `POST /introspect` with `{"token"}` answers as RFC 7662 does:
 *   `{"active": true, ...claims}` for a token this issuer signed that is
 *   still valid, else `{"active": false}` with the `JwtError` code.
 *
 * The `gateway` example is the other side: an API that verifies tokens
 * against an issuer's JWKS with `RemoteJwks`.
 *
 * ```sh
 * buck2 run root//src/celld/jwt/examples:issuer-dev
 * curl -sS -X POST localhost:9876/token -d '{"sub": "svc-reports", "scope": "read"}'
 * curl -sS localhost:9876/.well-known/jwks.json
 * ```
 *
 * @module
 */

import { DurableObject } from "cloudflare:workers";
import { parseDuration } from "@celld/isotime";
import {
  generateKeyPair,
  type Jwk,
  type Jwks,
  jwkThumbprint,
  JwtError,
  publicJwk,
  sign,
  verify,
} from "@celld/jwt";
import { ulid } from "@celld/ulid";

interface Env {
  readonly KEYS: DurableObjectNamespace<SigningKeys>;
  readonly ISSUER: string;
  readonly AUDIENCE: string;
  readonly SIGNING_ALG: string;
  readonly TOKEN_TTL: string;
}

type Alg = "EdDSA" | "ES256";

/** The current signing key: its `kid` and private JWK. */
export interface SigningKey {
  readonly kid: string;
  readonly alg: Alg;
  readonly jwk: Jwk;
}

/** How many keys the JWKS keeps: the current one and the one before. */
const PUBLISHED = 2;

/** The issuer's keys, newest last. */
export class SigningKeys extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS keys (seq INTEGER PRIMARY KEY AUTOINCREMENT, kid TEXT NOT NULL UNIQUE, alg TEXT NOT NULL, jwk TEXT NOT NULL)",
    );
  }

  /** The newest key, made on first use. */
  async current(): Promise<SigningKey> {
    return this.#newest() ?? await this.rotate();
  }

  /** Makes a new current key and drops all but the newest `PUBLISHED`. */
  async rotate(): Promise<SigningKey> {
    const alg = this.env.SIGNING_ALG === "EdDSA" ? "EdDSA" : "ES256";
    const { privateKey } = await generateKeyPair(alg, { extractable: true });
    const jwk = await crypto.subtle.exportKey("jwk", privateKey) as Jwk;
    const kid = await jwkThumbprint(jwk);
    const sql = this.ctx.storage.sql;
    sql.exec(
      "INSERT INTO keys (kid, alg, jwk) VALUES (?, ?, ?)",
      kid,
      alg,
      JSON.stringify(jwk),
    );
    sql.exec(
      "DELETE FROM keys WHERE seq NOT IN (SELECT seq FROM keys ORDER BY seq DESC LIMIT ?)",
      PUBLISHED,
    );
    // A key others will verify against must be durable before it signs.
    await this.ctx.storage.sync();
    return { kid, alg, jwk };
  }

  /** The published keys, newest first, without private members. */
  async jwks(): Promise<Jwks> {
    await this.current();
    const rows = this.ctx.storage.sql.exec<
      { kid: string; alg: string; jwk: string }
    >(
      "SELECT kid, alg, jwk FROM keys ORDER BY seq DESC",
    ).toArray();
    return {
      keys: rows.map(({ kid, alg, jwk }) => {
        const { key_ops: _ops, ext: _ext, ...key } = publicJwk(JSON.parse(jwk));
        return { ...key, kid, alg, use: "sig" };
      }),
    };
  }

  #newest(): SigningKey | null {
    const row =
      this.ctx.storage.sql.exec<{ kid: string; alg: Alg; jwk: string }>(
        "SELECT kid, alg, jwk FROM keys ORDER BY seq DESC LIMIT 1",
      ).toArray()[0];
    return row === undefined ? null : { ...row, jwk: JSON.parse(row.jwk) };
  }
}

function ttlSeconds(env: Env): number {
  const ttl = parseDuration(env.TOKEN_TTL);
  if (ttl === null) throw new Error("TOKEN_TTL is not a duration");
  // `total` refuses weeks, months and years, which have no fixed length.
  return Math.floor(ttl.total("seconds"));
}

async function token(request: Request, env: Env): Promise<Response> {
  const { sub, scope } = await request.json().catch(() => ({})) as {
    sub?: unknown;
    scope?: unknown;
  };
  if (
    typeof sub !== "string" ||
    (scope !== undefined && typeof scope !== "string")
  ) {
    return Response.json({ error: "invalid_request" }, { status: 400 });
  }
  const key = await env.KEYS.getByName("default").current();
  const ttl = ttlSeconds(env);
  const now = Date.now();
  const accessToken = await sign(
    {
      iss: env.ISSUER,
      aud: env.AUDIENCE,
      sub,
      ...(scope === undefined ? {} : { scope }),
      client_id: sub,
      jti: ulid(now),
    },
    key.jwk,
    {
      alg: key.alg,
      kid: key.kid,
      typ: "at+jwt",
      issuedAt: true,
      expiresIn: ttl,
      now,
    },
  );
  return Response.json({
    access_token: accessToken,
    token_type: "Bearer",
    expires_in: ttl,
  }, { headers: { "cache-control": "no-store" } });
}

async function introspect(request: Request, env: Env): Promise<Response> {
  const { token } = await request.json().catch(() => ({})) as {
    token?: unknown;
  };
  if (typeof token !== "string") {
    return Response.json({ error: "invalid_request" }, { status: 400 });
  }
  const jwks = await env.KEYS.getByName("default").jwks();
  try {
    const { payload } = await verify(token, jwks, {
      algorithms: ["EdDSA", "ES256"],
      issuer: env.ISSUER,
      audience: env.AUDIENCE,
      typ: "at+jwt",
      requiredClaims: ["exp", "jti"],
    });
    return Response.json({ active: true, ...payload });
  } catch (error) {
    if (error instanceof JwtError) {
      return Response.json({ active: false, error: error.code });
    }
    throw error;
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const route = `${request.method} ${new URL(request.url).pathname}`;
    const keys = env.KEYS.getByName("default");
    switch (route) {
      case "POST /token":
        return await token(request, env);
      case "GET /.well-known/jwks.json":
        return Response.json(await keys.jwks(), {
          headers: { "cache-control": "public, max-age=300" },
        });
      case "POST /rotate": {
        const { kid, alg } = await keys.rotate();
        return Response.json({ kid, alg });
      }
      case "POST /introspect":
        return await introspect(request, env);
    }
    return Response.json({ error: "not found" }, { status: 404 });
  },
};

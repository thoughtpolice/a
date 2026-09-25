// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * A token issuer with its own keys, rotation and a JWKS endpoint.
 *
 * The signing keys live in a `SigningKeys` Durable Object: generated with
 * `generateKeyPair` on first use, stored as JWKs in its SQLite, and named by
 * their RFC 7638 thumbprint (`jwkThumbprint`), so a `kid` is stable and says
 * which key it is. The algorithm is the `SIGNING_ALG` variable, `ES256` or
 * `EdDSA`; this example uses EdDSA.
 *
 * - `POST /token` with `{"sub", "scope"?}` issues an access token (`typ`
 *   `at+jwt`, RFC 9068) for `AUDIENCE`, valid for `TOKEN_TTL` (an ISO 8601
 *   duration), with a ULID `jti`. The subject and scope are the caller's
 *   to choose, so only a trusted client may ask: it needs
 *   `Authorization: Bearer <CLIENT_TOKEN>` (a secret of at least 32
 *   characters; without one configured, nobody can mint). One shared
 *   secret stands in for real client authentication (per-client
 *   credentials, `private_key_jwt` or mTLS, each limited to the subjects
 *   and scopes that client may ask for).
 * - `GET /.well-known/jwks.json` publishes the public keys, and never a
 *   private member, cacheable for `JWKS_MAX_AGE` (an ISO 8601 duration,
 *   default `PT5M`).
 * - `POST /rotate` publishes a new key. It is an admin operation: it needs
 *   `Authorization: Bearer <ADMIN_TOKEN>` (a secret of at least 32
 *   characters; without one configured, rotation is refused). The new key
 *   is in the JWKS at once but signs only after `JWKS_MAX_AGE`, when every
 *   verifier's cached copy of the JWKS has expired and a fresh one lists
 *   it; until then the previous key keeps signing, and a second rotation
 *   is refused (409 `rotation_pending`). A key that stops signing stays in
 *   the JWKS for `TOKEN_TTL` plus a minute of clock skew, so every token
 *   it signed verifies until it expires; only then is it dropped.
 * - `GET /keys` (admin) lists the keys with their state: `next` (published,
 *   not signing yet), `current` or `retired`.
 * - `POST /introspect` with `{"token"}` answers as RFC 7662 does:
 *   `{"active": true, ...claims}` for a token this issuer signed that is
 *   still valid, else `{"active": false}` with the `JwtError` code. It is
 *   deliberately unauthenticated: anyone may ask whether a
 *   token is live, and learns only the claims the token already carries.
 *   RFC 7662 expects resource-server authentication here; add it in front
 *   when liveness itself is sensitive.
 *
 * Request bodies are read under a cap (4 KiB for `/token`, 16 KiB for
 * `/introspect`, 413 beyond it) and parsed with `@celld/core/bounds`.
 *
 * The `gateway` example is the other side: an API that verifies tokens
 * against an issuer's JWKS with `RemoteJwks`.
 *
 * ```sh
 * buck2 run root//src/celld/sec/jwt/examples:issuer-dev
 * curl -sS -X POST localhost:9876/token -H "authorization: Bearer $CLIENT_TOKEN" \
 *   -d '{"sub": "svc-reports", "scope": "read"}'
 * curl -sS localhost:9876/.well-known/jwks.json
 * curl -sS -X POST localhost:9876/rotate -H "authorization: Bearer $ADMIN_TOKEN"
 * curl -sS localhost:9876/keys -H "authorization: Bearer $ADMIN_TOKEN"
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
import { parseDuration } from "@celld/core/isotime";
import {
  generateKeyPair,
  type Jwk,
  type Jwks,
  jwkThumbprint,
  JwtError,
  publicJwk,
  sign,
  verify,
} from "@celld/sec/jwt";
import { ulid } from "@celld/core/ulid";

interface Env {
  readonly KEYS: DurableObjectNamespace<SigningKeys>;
  readonly ISSUER: string;
  readonly AUDIENCE: string;
  readonly SIGNING_ALG: string;
  readonly TOKEN_TTL: string;
  readonly JWKS_MAX_AGE?: string;
  readonly ADMIN_TOKEN?: string;
  /** The one client allowed to mint tokens. A secret. */
  readonly CLIENT_TOKEN?: string;
}

type Alg = "EdDSA" | "ES256";

/** The current signing key: its `kid` and private JWK. */
export interface SigningKey {
  readonly kid: string;
  readonly alg: Alg;
  readonly jwk: Jwk;
}

/** Clock skew allowed for verifiers, on top of the token lifetime. */
const SKEW_MS = 60_000;

/** Where a key is in its life: published first, then signing, then kept. */
export type KeyState = "next" | "current" | "retired";

/** A key as `GET /keys` lists it. */
export interface KeyInfo {
  readonly kid: string;
  readonly alg: Alg;
  readonly state: KeyState;
  /** When it starts (or started) signing, RFC 3339. */
  readonly activatesAt: string;
}

/** `rotate()`'s refusal while a published key waits to sign. */
export interface RotationPending {
  readonly pending: KeyInfo;
}

type KeyRow = {
  readonly seq: number;
  readonly kid: string;
  readonly alg: Alg;
  readonly jwk: string;
  readonly activates_at: number;
};

/**
 * The issuer's keys, oldest first. A key is published (in the JWKS) from
 * the moment it is made, and signs from `activates_at`: `JWKS_MAX_AGE`
 * later for a rotation, at once for the very first key, which nobody can
 * have cached a JWKS without. The newest key whose time has come signs.
 */
export class SigningKeys extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS published_keys (seq INTEGER PRIMARY KEY AUTOINCREMENT, kid TEXT NOT NULL UNIQUE, alg TEXT NOT NULL, jwk TEXT NOT NULL, activates_at INTEGER NOT NULL)",
    );
  }

  /** The first key while it is being made, so concurrent calls share it. */
  #first?: Promise<KeyRow>;

  /** The key that signs now, made on first use. */
  async current(): Promise<SigningKey> {
    const now = Date.now();
    const row = this.#rows().findLast((key) => key.activates_at <= now) ??
      await (this.#first ??= this.#add(now));
    return { kid: row.kid, alg: row.alg, jwk: JSON.parse(row.jwk) };
  }

  /**
   * Publishes a new key that starts signing after `JWKS_MAX_AGE`, and drops
   * the keys that stopped signing longer ago than a token lives
   * (`TOKEN_TTL` plus skew): no unexpired token can name them. While an
   * earlier rotation's key is still waiting, it is refused.
   */
  async rotate(): Promise<KeyInfo | RotationPending> {
    const now = Date.now();
    await this.current();
    const waiting = this.#rows().find((key) => key.activates_at > now);
    if (waiting !== undefined) {
      return { pending: this.#info(waiting, now) };
    }
    const row = await this.#add(now + jwksMaxAgeSeconds(this.env) * 1000);
    // The newest key that had begun signing before the cutoff is the
    // oldest one a live token can name; everything before it goes.
    this.ctx.storage.sql.exec(
      "DELETE FROM published_keys WHERE seq < (SELECT MAX(seq) FROM published_keys WHERE activates_at < ?)",
      now - ttlSeconds(this.env) * 1000 - SKEW_MS,
    );
    await this.ctx.storage.sync();
    return this.#info(row, now);
  }

  /** Every key, newest first, with its state. */
  async keys(): Promise<KeyInfo[]> {
    await this.current();
    const now = Date.now();
    return this.#rows().map((row) => this.#info(row, now)).reverse();
  }

  /** The published keys, newest first, without private members. */
  async jwks(): Promise<Jwks> {
    await this.current();
    return {
      keys: this.#rows().reverse().map(({ kid, alg, jwk }) => {
        const { key_ops: _ops, ext: _ext, ...key } = publicJwk(JSON.parse(jwk));
        return { ...key, kid, alg, use: "sig" };
      }),
    };
  }

  async #add(activatesAt: number): Promise<KeyRow> {
    if (!["EdDSA", "ES256"].includes(this.env.SIGNING_ALG)) {
      throw new TypeError("SIGNING_ALG must be EdDSA or ES256");
    }
    const alg = this.env.SIGNING_ALG === "EdDSA" ? "EdDSA" : "ES256";
    const { privateKey } = await generateKeyPair(alg, { extractable: true });
    const jwk = await crypto.subtle.exportKey("jwk", privateKey) as Jwk;
    const kid = await jwkThumbprint(jwk);
    const row = this.ctx.storage.sql.exec<KeyRow>(
      "INSERT INTO published_keys (kid, alg, jwk, activates_at) VALUES (?, ?, ?, ?) RETURNING seq, kid, alg, jwk, activates_at",
      kid,
      alg,
      JSON.stringify(jwk),
      activatesAt,
    ).one();
    // A key others will verify against must be durable before it is
    // published, let alone signs.
    await this.ctx.storage.sync();
    return row;
  }

  #rows(): KeyRow[] {
    return this.ctx.storage.sql.exec<KeyRow>(
      "SELECT seq, kid, alg, jwk, activates_at FROM published_keys ORDER BY seq",
    ).toArray();
  }

  #info(row: KeyRow, now: number): KeyInfo {
    const later = this.#rows().filter((key) =>
      key.seq > row.seq && key.activates_at <= now
    );
    const state: KeyState = row.activates_at > now
      ? "next"
      : later.length > 0
      ? "retired"
      : "current";
    return {
      kid: row.kid,
      alg: row.alg,
      state,
      activatesAt: new Date(row.activates_at).toISOString(),
    };
  }
}

function seconds(value: string, name: string): number {
  const duration = parseDuration(value);
  if (duration === null) throw new Error(`${name} is not a duration`);
  // `total` refuses weeks, months and years, which have no fixed length.
  return Math.floor(duration.total("seconds"));
}

function ttlSeconds(env: Env): number {
  return seconds(env.TOKEN_TTL, "TOKEN_TTL");
}

/** How long a verifier may cache the JWKS, and so how long a new key waits. */
function jwksMaxAgeSeconds(env: Env): number {
  return seconds(env.JWKS_MAX_AGE ?? "PT5M", "JWKS_MAX_AGE");
}

/** A JSON body of at most `maxBytes`, or `{}` when it is not an object. */
async function readBody(
  request: Request,
  maxBytes: number,
): Promise<Record<string, unknown>> {
  const text = await readTextBounded(request, { maxBytes: bytes(maxBytes) });
  try {
    const body = parseJsonBounded(text, {
      maxDepth: 4,
      maxKeys: 16,
      maxItems: 16,
    });
    return typeof body === "object" && body !== null && !Array.isArray(body)
      ? body as Record<string, unknown>
      : {};
  } catch (error) {
    if (error instanceof BoundsError) return {};
    throw error;
  }
}

async function token(request: Request, env: Env): Promise<Response> {
  const { sub, scope } = await readBody(request, 4096);
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

async function digest(text: string): Promise<Uint8Array> {
  return new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)),
  );
}

/**
 * Whether the request carries `Bearer <expected>`, compared in constant
 * time (over SHA-256 digests, so the length does not leak either). A
 * secret shorter than 32 characters (or unset) admits nobody.
 */
async function carries(
  request: Request,
  expected: string | undefined,
): Promise<boolean> {
  if (expected === undefined || expected.length < 32) return false;
  const presented = /^Bearer (\S+)$/.exec(
    request.headers.get("authorization") ?? "",
  )?.[1] ?? "";
  const [a, b] = await Promise.all([digest(presented), digest(expected)]);
  let difference = 0;
  for (let i = 0; i < a.length; i++) difference |= a[i] ^ b[i];
  return difference === 0;
}

async function introspect(request: Request, env: Env): Promise<Response> {
  const { token } = await readBody(request, 16 * 1024);
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

function unauthorized(realm: string): Response {
  return Response.json({ error: "unauthorized" }, {
    status: 401,
    headers: { "www-authenticate": `Bearer realm="${realm}"` },
  });
}

async function route(request: Request, env: Env): Promise<Response> {
  const route = `${request.method} ${new URL(request.url).pathname}`;
  const keys = env.KEYS.getByName("default");
  switch (route) {
    case "POST /token":
      if (!(await carries(request, env.CLIENT_TOKEN))) {
        return unauthorized("issuer");
      }
      return await token(request, env);
    case "GET /.well-known/jwks.json":
      return Response.json(await keys.jwks(), {
        headers: {
          "cache-control": `public, max-age=${jwksMaxAgeSeconds(env)}`,
        },
      });
    case "POST /rotate": {
      if (!(await carries(request, env.ADMIN_TOKEN))) {
        return unauthorized("issuer-admin");
      }
      const rotated = await keys.rotate();
      if ("pending" in rotated) {
        return Response.json({
          error: "rotation_pending",
          kid: rotated.pending.kid,
          activatesAt: rotated.pending.activatesAt,
        }, { status: 409 });
      }
      return Response.json(rotated);
    }
    case "GET /keys":
      if (!(await carries(request, env.ADMIN_TOKEN))) {
        return unauthorized("issuer-admin");
      }
      return Response.json({ keys: await keys.keys() });
    case "POST /introspect":
      return await introspect(request, env);
  }
  return Response.json({ error: "not found" }, { status: 404 });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    try {
      return await route(request, env);
    } catch (error) {
      if (error instanceof BoundsError && error.code === "too_large") {
        return Response.json({ error: "too_large" }, { status: 413 });
      }
      throw error;
    }
  },
};

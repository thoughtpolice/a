// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * A fake OAuth authorization server for the `gateway` example, built on
 * `@celld/jwt` itself: it signs ES256 access tokens with keys it generates
 * at startup and publishes them as a JWKS.
 *
 * - `POST /oauth/token` with `{"client_id", "scope"?}` returns
 *   `{"access_token", "token_type", "expires_in"}`: an `at+jwt` token
 *   whose `iss` is this server's origin, `aud` is `https://api.example`,
 *   `sub` and `client_id` are the client, and which expires in 5 minutes.
 * - `GET /.well-known/jwks.json` lists the public keys, newest first.
 *
 * `script` entries a spec can send:
 *
 * - `{"rotate": true}`: a new signing key, published ahead of the old one,
 *   which stays in the JWKS.
 * - `{"next": {...}}`: the next token only: `claims` merged over the usual
 *   ones, `expiresIn` seconds, or `kid`, a `kid` header naming no key.
 *
 * It sets `ISSUER`, `JWKS_URL` and `TOKEN_URL` to itself.
 *
 * @module
 */

import { serveUpstream } from "@celld/examples/upstream";
import { generateKeyPair, type Jwk, jwkThumbprint, sign } from "@celld/jwt";

interface Key {
  readonly kid: string;
  readonly privateKey: CryptoKey;
  readonly publicJwk: Jwk;
}

interface Next {
  readonly claims?: Record<string, unknown>;
  readonly expiresIn?: number;
  readonly kid?: string;
}

async function newKey(): Promise<Key> {
  const { privateKey, publicJwk } = await generateKeyPair("ES256");
  const kid = await jwkThumbprint(publicJwk);
  return { kid, privateKey, publicJwk: { ...publicJwk, kid, use: "sig" } };
}

const keys: Key[] = [await newKey()];
let next: Next = {};
let origin = "";

async function token(request: Request): Promise<Response> {
  const { client_id: client, scope } = await request.json() as {
    client_id?: unknown;
    scope?: unknown;
  };
  if (typeof client !== "string") {
    return Response.json({ error: "invalid_client" }, { status: 401 });
  }
  const { claims = {}, expiresIn = 300, kid } = next;
  next = {};
  const key = keys[0];
  const accessToken = await sign(
    {
      iss: origin,
      aud: "https://api.example",
      sub: client,
      client_id: client,
      ...(typeof scope === "string" ? { scope } : {}),
      jti: crypto.randomUUID(),
      ...claims,
    },
    key.privateKey,
    {
      alg: "ES256",
      kid: kid ?? key.kid,
      typ: "at+jwt",
      issuedAt: true,
      expiresIn,
    },
  );
  return Response.json({
    access_token: accessToken,
    token_type: "Bearer",
    expires_in: expiresIn,
  });
}

serveUpstream({
  async fetch(request) {
    const route = `${request.method} ${new URL(request.url).pathname}`;
    if (route === "POST /oauth/token") return await token(request);
    if (route === "GET /.well-known/jwks.json") {
      return Response.json({ keys: keys.map((key) => key.publicJwk) });
    }
    return Response.json({ error: "not found" }, { status: 404 });
  },
  async script(instruction) {
    const { rotate, next: upcoming } = instruction as {
      rotate?: boolean;
      next?: Next;
    };
    if (rotate) keys.unshift(await newKey());
    if (upcoming !== undefined) next = upcoming;
  },
  vars(listening) {
    origin = listening;
    return {
      ISSUER: listening,
      JWKS_URL: `${listening}/.well-known/jwks.json`,
      TOKEN_URL: `${listening}/oauth/token`,
    };
  },
});

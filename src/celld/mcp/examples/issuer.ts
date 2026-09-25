// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * The `protected` example's fake authorization server: only the parts a
 * resource server touches.
 *
 * - `GET /jwks`: the issuer's JWK Set, one P-256 key with kid
 *   `example-2026`;
 * - `POST /token` with `{"sub", "scope", "aud"?, "kid"?, "expiresIn"?}`
 *   mints an RFC 9068 access token (`typ: at+jwt`, with `client_id`, `iat`
 *   and a fresh `jti`, which the profile requires) with `@celld/jwt`, for
 *   trying the `-dev` target with `curl`. The spec's tokens were minted
 *   with the same key and claims, `iat` 1790000000, `exp` 4102444800
 *   (2100) and `jti`s of their own.
 *
 * The Worker finds the key set through `OAUTH_JWKS_URI`. The private key
 * below is published with the example, so nothing may trust it.
 *
 * @module
 */

import { serveUpstream } from "@celld/examples/upstream";
import { type Jwk, publicJwk, sign } from "@celld/jwt";

const ISSUER = "https://auth.example.com";
const KID = "example-2026";
const KEY: Jwk = {
  kty: "EC",
  crv: "P-256",
  x: "MPPXCZfT590LjGM1yBPdscLILfFZnPMAwzwx_z9aHqg",
  y: "BSBLAE0jShSD5lfG4sKjuVv0Y2cm_ZBXwL0XblhT-ek",
  d: "SuOnbtkowjc2mYe-KBwJkuaV0kWEOiB-6ySgF2-L4J0",
};

interface Mint {
  readonly sub?: string;
  readonly scope?: string;
  readonly aud?: string;
  readonly kid?: string;
  readonly expiresIn?: number;
}

async function mint(body: Mint): Promise<Response> {
  const token = await sign(
    {
      iss: ISSUER,
      sub: body.sub ?? "alice",
      aud: body.aud ?? "https://notes.example.com/mcp",
      scope: body.scope ?? "notes:read",
      client_id: "notes-app",
      jti: crypto.randomUUID(),
    },
    KEY,
    {
      alg: "ES256",
      kid: body.kid ?? KID,
      typ: "at+jwt",
      issuedAt: true,
      expiresIn: body.expiresIn ?? 3600,
    },
  );
  return Response.json({ access_token: token, token_type: "Bearer" });
}

serveUpstream({
  async fetch(request) {
    const { pathname } = new URL(request.url);
    if (request.method === "GET" && pathname === "/jwks") {
      return Response.json({
        keys: [{ ...publicJwk(KEY), kid: KID, alg: "ES256", use: "sig" }],
      });
    }
    if (request.method === "POST" && pathname === "/token") {
      return await mint(await request.json() as Mint);
    }
    return Response.json({ error: "not_found" }, { status: 404 });
  },
  vars: (origin) => ({ OAUTH_JWKS_URI: `${origin}/jwks` }),
});

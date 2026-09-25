// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * The `reports` example's fake authorization server: its JWK Set, which
 * is all a resource server fetches.
 *
 * - `GET /jwks`: one P-256 key, kid `reports-2026`.
 * - `POST /token` with `{"sub", "scope"?, "roles"?}` mints an RFC 9068
 *   access token (`typ: at+jwt`, ES256) for trying the `-dev` target with
 *   `curl`. The spec's tokens were minted once with the same key, `iat`
 *   1790000000 and `exp` 4102444800 (2100), so the spec is deterministic.
 *
 * The Worker finds the key set through `JWKS_URI`. The private key below
 * is published with the example, so nothing may trust it.
 *
 * @module
 */

import { serveUpstream } from "@celld/examples/upstream";
import { type Jwk, publicJwk, sign } from "@celld/jwt";

const KID = "reports-2026";
const KEY: Jwk = {
  kty: "EC",
  crv: "P-256",
  x: "PXUOXWjP3T74dtZ9U1OhKuhdJ6RXh74dQSIgutG-d7A",
  y: "DjUQfUknFea3S19uubCWZh2QDOXnsuINpEg-HD3GqBI",
  d: "9UBFZm0efgHa31Lha4Ljmh_mXNM-duf6-7vc-4AGmjE",
};

interface Mint {
  readonly sub?: string;
  readonly scope?: string;
  readonly roles?: readonly string[];
}

async function mint(body: Mint): Promise<Response> {
  const token = await sign(
    {
      iss: "https://auth.example.com",
      aud: "https://reports.example.com",
      sub: body.sub ?? "alice",
      scope: body.scope ?? "reports:read",
      ...(body.roles === undefined ? {} : { roles: body.roles }),
      client_id: "dashboard",
    },
    KEY,
    { alg: "ES256", kid: KID, typ: "at+jwt", issuedAt: true, expiresIn: 3600 },
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
  vars: (origin) => ({ JWKS_URI: `${origin}/jwks` }),
});

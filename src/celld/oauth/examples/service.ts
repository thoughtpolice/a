// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * Service to service with the client credentials grant: this Worker calls
 * another team's reports API as itself, with no user.
 *
 * - `GET /report`: today's report from the API.
 * - `GET /report?scope=reports:write`: asks for a scope the client is not
 *   allowed; the authorization server's `invalid_scope` comes back as 502.
 *
 * `OAuthClient` discovers the authorization server (`SERVICE_ISSUER`,
 * RFC 8414), authenticates with `private_key_jwt` (a fresh assertion with
 * `aud` the issuer and a new `jti` per request; the key is `CLIENT_JWK`)
 * and asks for a token for exactly the API's resource (RFC 8707). The
 * token is kept per isolate until 30 seconds before it expires. When the
 * API refuses it anyway (`invalid_token`: revoked, or the issuer rotated
 * its keys), the Worker drops it, gets a new one, and retries once.
 *
 * ```sh
 * buck2 run root//src/celld/oauth/examples:service-dev
 * curl -sS localhost:9876/report
 * ```
 *
 * @module
 */

import { fromBase64Url, importKey, type Jwk } from "@celld/jwt";
import { isOAuthError, resourceChallenge } from "@celld/oauth";
import { OAuthClient, type TokenSet } from "@celld/oauth/client";
import { HttpError, router } from "@celld/router";
import { v } from "@celld/sieve";

interface Env {
  readonly SERVICE_ISSUER: string;
  readonly REPORTS_API: string;
  readonly CLIENT_ID: string;
  /** The client's private ES256 JWK, as base64url JSON. */
  readonly CLIENT_JWK: string;
}

let client: Promise<OAuthClient> | null = null;
const tokens = new Map<string, TokenSet>();

async function oauth(env: Env): Promise<OAuthClient> {
  client ??= (async () => {
    const jwk = JSON.parse(
      new TextDecoder().decode(fromBase64Url(env.CLIENT_JWK)!),
    ) as Jwk;
    return new OAuthClient({
      issuer: env.SERVICE_ISSUER,
      client: {
        method: "private_key_jwt",
        clientId: env.CLIENT_ID,
        privateKey: await importKey(jwk, "ES256", "sign"),
        alg: "ES256",
        kid: jwk.kid,
      },
    });
  })();
  return await client;
}

async function token(env: Env, scope: string): Promise<TokenSet> {
  const held = tokens.get(scope);
  if (held !== undefined && (held.expires_at ?? 0) - 30_000 > Date.now()) {
    return held;
  }
  const fresh = await (await oauth(env)).clientCredentials({
    scope: [scope],
    resource: env.REPORTS_API,
  });
  tokens.set(scope, fresh);
  return fresh;
}

async function report(env: Env, scope: string): Promise<Response> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const { access_token } = await token(env, scope);
    const response = await fetch(`${env.REPORTS_API}/reports/daily`, {
      headers: { authorization: `Bearer ${access_token}` },
    });
    const refused = resourceChallenge(response.headers.get("www-authenticate"));
    if (response.status !== 401 || refused?.error !== "invalid_token") {
      return response;
    }
    await response.body?.cancel();
    tokens.delete(scope);
  }
  throw new HttpError(502, "the reports API refused a fresh token");
}

const app = router<Env>({ auth: "none" });

app.get("/report", {
  public: true,
  query: v.object({ scope: v.string().default("reports:read") }),
}, async (c) => {
  try {
    const response = await report(c.env, c.query.scope);
    if (!response.ok) {
      throw new HttpError(502, `the reports API answered ${response.status}`);
    }
    return c.json(await response.json());
  } catch (error) {
    if (isOAuthError(error)) {
      throw new HttpError(
        502,
        `could not get a token: ${error.error ?? error.kind}`,
        {
          expose: true,
          code: error.error ?? error.kind,
        },
      );
    }
    throw error;
  }
});

export default { fetch: app.fetch };

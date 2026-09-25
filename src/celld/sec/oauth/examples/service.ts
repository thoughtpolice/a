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
 * its keys), the Worker drops it, gets a new one, and retries once. The
 * token goes to the API with redirects refused (it is for that URL only)
 * and a deadline, and the answer is read under a 64 KiB cap; a redirect,
 * a timeout or an oversized answer is a 502.
 *
 * The route is deliberately unauthenticated (see the comment on `app`):
 * anyone who can reach this Worker reads the reports API through its
 * credentials.
 *
 * ```sh
 * buck2 run root//src/celld/sec/oauth/examples:service-dev
 * curl -sS localhost:9876/report
 * ```
 *
 * @module
 */

import { parseJsonBounded, readTextBounded } from "@celld/core/bounds";
import { fromBase64Url, importKey, type Jwk } from "@celld/sec/jwt";
import { isOAuthError, resourceChallenge } from "@celld/sec/oauth";
import { OAuthClient, type TokenSet } from "@celld/sec/oauth/client";
import { HttpError, router } from "@celld/web/router";
import { v } from "@celld/sieve";

interface Env {
  readonly SERVICE_ISSUER: string;
  readonly REPORTS_API: string;
  readonly CLIENT_ID: string;
  /** The client's private ES256 JWK, as base64url JSON. */
  readonly CLIENT_JWK: string;
  /** "true" lets discovery reach an issuer on http://127.0.0.1. */
  readonly OAUTH_LOOPBACK_FOR_DEVELOPMENT?: string;
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
      allowLoopbackForDevelopment:
        env.OAUTH_LOOPBACK_FOR_DEVELOPMENT === "true",
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
    // No redirects: the token is for this URL only. A deadline covers the
    // answer's body too, since the signal aborts its stream.
    const response = await fetch(`${env.REPORTS_API}/reports/daily`, {
      headers: { authorization: `Bearer ${access_token}` },
      redirect: "error",
      signal: AbortSignal.timeout(10_000),
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

// Deliberately unauthenticated, to keep the example about the client side:
// any caller gets the reports API's data through this service's own
// `private_key_jwt` credentials (a confused deputy). A real service
// authenticates its callers and decides what each may see. The `scope` a
// caller may name is one of two; the authorization server's grant to this
// client (`reports:read` only) is the real limit.
const app = router<Env>({ auth: "none" });

app.get("/report", {
  public: true,
  query: v.object({
    scope: v.enum(["reports:read", "reports:write"]).default("reports:read"),
  }),
}, async (c) => {
  let response: Response;
  try {
    response = await report(c.env, c.query.scope);
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
    if (error instanceof HttpError) throw error;
    // A redirect, a timeout or a network failure.
    console.error("the reports API call failed", error);
    throw new HttpError(502, "the reports API could not be reached");
  }
  if (!response.ok) {
    await response.body?.cancel();
    throw new HttpError(502, `the reports API answered ${response.status}`);
  }
  let body: unknown;
  try {
    body = parseJsonBounded(
      await readTextBounded(response, { maxBytes: 64 * 1024 }),
      { maxDepth: 8, maxKeys: 64, maxItems: 1000 },
    );
  } catch (error) {
    console.error("the reports API's answer was unreadable", error);
    throw new HttpError(502, "the reports API's answer was unreadable");
  }
  return c.json(body);
});

export default { fetch: app.fetch };

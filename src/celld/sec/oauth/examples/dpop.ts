// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * A DPoP client (RFC 9449): this Worker lists files from an API that only
 * takes DPoP-bound tokens, so a token that leaks from it is useless
 * without its private key.
 *
 * - `GET /files`: the file list, the thumbprint of the Worker's key, and
 *   the one the API says the token is bound to.
 *
 * The Worker holds one non-extractable ES256 `DpopKey` per isolate. Its
 * token request carries a proof, so the token comes back `DPoP` with
 * `cnf.jkt` of that key; `OAuthClient` refuses a Bearer answer, and
 * retries once when the authorization server asks for a nonce
 * (`use_dpop_nonce`). Each API call carries a fresh proof for its method
 * and URL with `ath`, the token's hash, and the API's latest `DPoP-Nonce`
 * (kept per origin in a `DpopNonceCache`, apart from the authorization
 * server's); a 401 `use_dpop_nonce` challenge is retried once with the
 * nonce it sent. Redirects are refused (the token and its proof are for
 * the API's URL only), each call has a deadline, and the answer is read
 * under a 64 KiB cap; a redirect, a timeout or an oversized answer is a
 * 502.
 *
 * The route is deliberately unauthenticated (see the comment on `app`):
 * anyone who can reach this Worker reads the files API through its
 * credentials.
 *
 * ```sh
 * buck2 run root//src/celld/sec/oauth/examples:dpop-dev
 * curl -sS localhost:9876/files
 * ```
 *
 * @module
 */

import { parseJsonBounded, readTextBounded } from "@celld/core/bounds";
import { resourceChallenge } from "@celld/sec/oauth";
import { OAuthClient, type TokenSet } from "@celld/sec/oauth/client";
import { DpopKey, DpopNonceCache } from "@celld/sec/oauth/dpop";
import { HttpError, router } from "@celld/web/router";

interface Env {
  readonly FILES_ISSUER: string;
  readonly FILES_API: string;
  readonly CLIENT_ID: string;
  readonly CLIENT_SECRET: string;
  /** "true" lets discovery reach an issuer on http://127.0.0.1. */
  readonly OAUTH_LOOPBACK_FOR_DEVELOPMENT?: string;
}

let key: Promise<DpopKey> | null = null;
let client: OAuthClient | null = null;
let held: TokenSet | null = null;
const nonces = new DpopNonceCache();

async function tokens(env: Env): Promise<{ key: DpopKey; tokens: TokenSet }> {
  const dpop = await (key ??= DpopKey.generate());
  client ??= new OAuthClient({
    issuer: env.FILES_ISSUER,
    client: {
      method: "client_secret_basic",
      clientId: env.CLIENT_ID,
      clientSecret: env.CLIENT_SECRET,
    },
    dpop,
    allowLoopbackForDevelopment: env.OAUTH_LOOPBACK_FOR_DEVELOPMENT === "true",
  });
  if (held === null || (held.expires_at ?? 0) - 30_000 <= Date.now()) {
    held = await client.clientCredentials({
      scope: ["files:read"],
      resource: env.FILES_API,
    });
  }
  return { key: dpop, tokens: held };
}

async function call(env: Env, url: string): Promise<Response> {
  const { key, tokens: set } = await tokens(env);
  let response: Response | null = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    // No redirects: the token and its proof are for this URL only. The
    // deadline covers the answer's body too.
    response = await fetch(url, {
      redirect: "error",
      signal: AbortSignal.timeout(10_000),
      headers: {
        authorization: `DPoP ${set.access_token}`,
        dpop: await key.proof({
          method: "GET",
          url,
          accessToken: set.access_token,
          nonce: nonces.get(url),
        }),
      },
    });
    const fresh = nonces.update(url, response);
    const challenge = resourceChallenge(
      response.headers.get("www-authenticate"),
      "DPoP",
    );
    if (
      response.status !== 401 || challenge?.error !== "use_dpop_nonce" ||
      fresh === undefined
    ) {
      break;
    }
    await response.body?.cancel();
  }
  return response!;
}

// Deliberately unauthenticated, to keep the example about the client side:
// any caller gets the files API's list through this Worker's DPoP-bound
// client credentials (a confused deputy). A real service authenticates
// its callers and decides what each may see.
const app = router<Env>({ auth: "none" });

app.get("/files", { public: true }, async (c) => {
  const { key, tokens: set } = await tokens(c.env);
  let response: Response;
  try {
    response = await call(c.env, `${c.env.FILES_API}/files`);
  } catch (error) {
    // A redirect, a timeout or a network failure.
    console.error("the files API call failed", error);
    throw new HttpError(502, "the files API could not be reached");
  }
  if (!response.ok) {
    await response.body?.cancel();
    throw new HttpError(502, `the files API answered ${response.status}`);
  }
  let answer: { files?: unknown; boundTo?: unknown };
  try {
    const parsed = parseJsonBounded(
      await readTextBounded(response, { maxBytes: 64 * 1024 }),
      { maxDepth: 4, maxKeys: 16, maxItems: 1000 },
    );
    if (typeof parsed !== "object" || parsed === null) {
      throw new TypeError("the answer is not a JSON object");
    }
    answer = parsed;
  } catch (error) {
    console.error("the files API's answer was unreadable", error);
    throw new HttpError(502, "the files API's answer was unreadable");
  }
  // Only the fields the Worker expects, by name: the API's answer cannot
  // overwrite the Worker's own (`tokenType`, `key`).
  return c.json({
    tokenType: set.token_type,
    key: key.jkt,
    files: answer.files ?? null,
    boundTo: answer.boundTo ?? null,
  });
});

export default { fetch: app.fetch };

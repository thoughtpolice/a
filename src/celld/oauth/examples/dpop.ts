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
 * nonce it sent.
 *
 * ```sh
 * buck2 run root//src/celld/oauth/examples:dpop-dev
 * curl -sS localhost:9876/files
 * ```
 *
 * @module
 */

import { resourceChallenge } from "@celld/oauth";
import { OAuthClient, type TokenSet } from "@celld/oauth/client";
import { DpopKey, DpopNonceCache } from "@celld/oauth/dpop";
import { HttpError, router } from "@celld/router";

interface Env {
  readonly FILES_ISSUER: string;
  readonly FILES_API: string;
  readonly CLIENT_ID: string;
  readonly CLIENT_SECRET: string;
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
    response = await fetch(url, {
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

const app = router<Env>({ auth: "none" });

app.get("/files", { public: true }, async (c) => {
  const { key, tokens: set } = await tokens(c.env);
  const response = await call(c.env, `${c.env.FILES_API}/files`);
  if (!response.ok) {
    throw new HttpError(502, `the files API answered ${response.status}`);
  }
  return c.json({
    tokenType: set.token_type,
    key: key.jkt,
    ...await response.json(),
  });
});

export default { fetch: app.fetch };

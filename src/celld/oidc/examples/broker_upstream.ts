// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * A fake upstream OpenID Provider for the `broker` example:
 * `@celld/oidc/testing`'s `testProvider` at the fake's own origin. Its one
 * client, `broker`, is confidential (`client_secret_basic`), redirects to
 * `http://127.0.0.1/upstream/callback` on any port, and is registered
 * with `dpop_bound_access_tokens`: the provider refuses its token
 * requests without a DPoP proof, and binds its tokens to the proof's key.
 * Consent signs `alice` in at once, by password and one-time code
 * (`acr` `urn:upstream:mfa`, `amr` `pwd otp`).
 *
 * It sets `UPSTREAM_ISSUER`, `UPSTREAM_CLIENT_ID` and
 * `UPSTREAM_CLIENT_SECRET` for the Worker. It takes no script.
 *
 * @module
 */

import { serveUpstream } from "@celld/examples/upstream";
import { type TestProvider, testProvider } from "@celld/oidc/testing";

const SECRET = "upstream-client-secret-0123456789";

let provider: Promise<TestProvider> | null = null;

serveUpstream({
  fetch: async (request) => {
    if (provider === null) return new Response("starting", { status: 503 });
    return await (await provider).handle(request);
  },
  vars: (origin) => {
    provider = testProvider({
      issuer: origin,
      clients: [{
        client_id: "broker",
        client_secret: SECRET,
        redirect_uris: ["http://127.0.0.1/upstream/callback"],
        dpop_bound_access_tokens: true,
      }],
      users: {
        alice: {
          name: "Alice Liddell",
          email: "alice@upstream.example",
          email_verified: true,
        },
      },
      consent: () => ({
        grant: {
          subject: "alice",
          authTime: Math.floor(Date.now() / 1000),
          acr: "urn:upstream:mfa",
          amr: ["pwd", "otp"],
          sessionId: "upstream-session",
        },
      }),
    });
    return {
      UPSTREAM_ISSUER: origin,
      UPSTREAM_CLIENT_ID: "broker",
      UPSTREAM_CLIENT_SECRET: SECRET,
    };
  },
});

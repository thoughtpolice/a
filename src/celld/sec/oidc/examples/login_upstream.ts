// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * A fake OpenID Provider for the `login` example: `@celld/sec/oidc/testing`'s
 * `testProvider` at the fake's own origin, signing `user-1` (Ada
 * Lovelace) in at once as consent. Its one client, `web`, is public and
 * redirects to `http://127.0.0.1/callback` on any port (RFC 8252), which is
 * where the Worker under test listens.
 *
 * It sets `OIDC_ISSUER` to itself, `OIDC_CLIENT_ID` to `web` and
 * `OIDC_LOOPBACK_FOR_DEVELOPMENT` (it is served over http on 127.0.0.1).
 * It takes no script.
 *
 * @module
 */

import { serveUpstream } from "@celld/examples/upstream";
import { type TestProvider, testProvider } from "@celld/sec/oidc/testing";

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
        client_id: "web",
        redirect_uris: ["http://127.0.0.1/callback"],
      }],
    });
    return {
      OIDC_ISSUER: origin,
      OIDC_CLIENT_ID: "web",
      // The fake serves http://127.0.0.1, which only the development
      // override allows.
      OIDC_LOOPBACK_FOR_DEVELOPMENT: "true",
    };
  },
});

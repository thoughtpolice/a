// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * The `dpop` example's upstream: a files API that accepts only
 * DPoP-bound tokens (RFC 9449), and its authorization server, both from
 * `@celld/oauth/testing`. Both demand server nonces, each from its own
 * `DpopNonceIssuer`, and the API remembers every proof's `jti`.
 *
 * - `/as/...` and `GET /.well-known/oauth-authorization-server/as`: the
 *   authorization server; one client, `files-agent`
 *   (`client_secret_basic`, `dpop_bound_access_tokens`), allowed the
 *   client credentials grant for `files:read`.
 * - `GET /api/files`: needs a DPoP-bound token for `/api` with
 *   `files:read` and a proof with the API's current nonce.
 *
 * `script` entries a spec can send. Each checks the API's answer itself
 * and throws (so the harness fails the step) unless it is the refusal
 * described; neither is recorded as a request, since neither comes from
 * the Worker.
 *
 * - `{"replay": true}`: sends the Worker's last API request again, as is,
 *   to the API; it must be refused 401 `invalid_dpop_proof` (the proof's
 *   `jti` was used).
 * - `{"downgrade": true}`: sends the Worker's last token again as
 *   `Authorization: Bearer` without a proof; it must be refused 401
 *   `invalid_token` (a bound token is not a bearer token).
 *
 * It sets `FILES_ISSUER`, `FILES_API`, `CLIENT_ID` and `CLIENT_SECRET`.
 *
 * @module
 */

import { serveUpstream } from "@celld/examples/upstream";
import { resourceChallenge } from "@celld/oauth";
import { DpopNonceIssuer, memoryReplayStore } from "@celld/oauth/dpop";
import {
  serveResource,
  type TestAuthorizationServer,
  testAuthorizationServer,
  testResourceServer,
} from "@celld/oauth/testing";

const CLIENT_SECRET = "files-agent-secret-0123456789";

interface Site {
  readonly as: TestAuthorizationServer;
  readonly api: (request: Request) => Promise<Response>;
}

let origin = "";
let site: Promise<Site> | null = null;
let last: Request | null = null;

async function build(): Promise<Site> {
  const api = `${origin}/api`;
  const as = await testAuthorizationServer({
    issuer: `${origin}/as`,
    clients: [{
      client_id: "files-agent",
      client_secret: CLIENT_SECRET,
      grant_types: ["client_credentials"],
      scope: "files:read",
      dpop_bound_access_tokens: true,
    }],
    scopesSupported: ["files:read"],
    resources: { allowed: [api] },
    dpop: { nonce: await DpopNonceIssuer.create() },
  });
  const resource = testResourceServer(as, {
    resource: api,
    dpop: {
      required: true,
      nonce: await DpopNonceIssuer.create(),
      replay: memoryReplayStore(),
    },
  });
  return {
    as,
    api: serveResource(
      resource,
      (_request, principal) =>
        Response.json({
          files: ["q3-plan.md", "budget.xlsx"],
          boundTo: principal.cnf?.jkt ?? null,
        }),
      { scopes: ["files:read"] },
    ),
  };
}

async function expectRefusal(request: Request, error: string): Promise<void> {
  const { api } = await (site ??= build());
  const response = await api(request);
  const challenge = resourceChallenge(response.headers.get("www-authenticate"));
  if (response.status !== 401 || challenge?.error !== error) {
    throw new Error(
      `expected 401 ${error}, got ${response.status} ${challenge?.error ?? ""}`,
    );
  }
}

serveUpstream({
  async fetch(request) {
    const { as, api } = await (site ??= build());
    const path = new URL(request.url).pathname;
    if (path.startsWith("/api") || path.includes("oauth-protected-resource")) {
      if (path.startsWith("/api")) last = request.clone();
      return await api(request);
    }
    return await as.handle(request);
  },
  async script(instruction) {
    const step = instruction as { replay?: boolean; downgrade?: boolean };
    if (last === null) throw new Error("the Worker has not called the API yet");
    if (step.replay) {
      await expectRefusal(last.clone(), "invalid_dpop_proof");
    }
    if (step.downgrade) {
      const token = last.headers.get("authorization")!.replace(/^DPoP /, "");
      await expectRefusal(
        new Request(last.url, {
          headers: { authorization: `Bearer ${token}` },
        }),
        "invalid_token",
      );
    }
  },
  vars(listening) {
    origin = listening;
    return {
      FILES_ISSUER: `${listening}/as`,
      FILES_API: `${listening}/api`,
      CLIENT_ID: "files-agent",
      CLIENT_SECRET,
    };
  },
});

// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * The `service` example's upstream: another team's reports API and its
 * authorization server, both from `@celld/sec/oauth/testing`.
 *
 * - `/as/...` and `GET /.well-known/oauth-authorization-server/as`: an
 *   authorization server that knows one client, `reports-service`,
 *   authenticating with `private_key_jwt` and allowed the client
 *   credentials grant for `reports:read` only.
 * - `GET /api/reports/daily`: needs an access token for `/api` with
 *   `reports:read`; `GET /.well-known/oauth-protected-resource/api` is its
 *   metadata.
 *
 * `script` entries a spec can send:
 *
 * - `{"rotate": true}`: the authorization server gets a new signing key and
 *   the API trusts only it, so every token issued so far is refused
 *   (`invalid_token`), as after a key compromise.
 * - `{"answer": "redirect"}`: the next `GET /api/reports/daily` answers 302
 *   to `/elsewhere` instead (a token that followed it would show up there).
 * - `{"answer": "huge"}`: the next `GET /api/reports/daily` answers 200
 *   with a 256 KiB JSON document.
 *
 * It sets `SERVICE_ISSUER`, `REPORTS_API`, `CLIENT_ID` and `CLIENT_JWK`
 * (the client's private key, as base64url JSON) for the Worker.
 *
 * @module
 */

import { serveUpstream } from "@celld/examples/upstream";
import { fromBase64Url, type Jwk, publicJwk } from "@celld/sec/jwt";
import { generateSigningKey } from "@celld/sec/oauth/server";
import {
  serveResource,
  type TestAuthorizationServer,
  testAuthorizationServer,
  testResourceServer,
} from "@celld/sec/oauth/testing";

const CLIENT_JWK =
  "eyJrdHkiOiJFQyIsImNydiI6IlAtMjU2Iiwia2lkIjoic2VydmljZS1jbGllbnQiLCJ4IjoiOGIxbFJ6bXhma2pQZmZvVk9KM2JMenVoYlNmUFlxZFNZQ3lFVEFxZDVETSIsInkiOiJudzluRGRIMnQ2bnRfWURvZ1NCaEFZV3BhNEVLSnozMzljZWFPU0hlNUJNIiwiZCI6Ims1clI3emxfZkI2aVdVNE50U203bjBUR2xPNWZJZUs2cHRMWG1LaUpwMDgifQ";

interface Site {
  readonly as: TestAuthorizationServer;
  readonly api: (request: Request) => Promise<Response>;
}

let origin = "";
let generation = 0;
let current: Promise<Site> | null = null;
let next: "redirect" | "huge" | null = null;

/** A scripted answer in place of the API's, or null for the API's own. */
function scripted(path: string): Response | null {
  const answer = next;
  if (answer === null || path !== "/api/reports/daily") return null;
  next = null;
  if (answer === "redirect") {
    return new Response(null, {
      status: 302,
      headers: { location: `${origin}/elsewhere` },
    });
  }
  return Response.json({ report: "x".repeat(256 * 1024) });
}

async function site(): Promise<Site> {
  const client = JSON.parse(
    new TextDecoder().decode(fromBase64Url(CLIENT_JWK)!),
  ) as Jwk;
  const api = `${origin}/api`;
  const as = await testAuthorizationServer({
    issuer: `${origin}/as`,
    keys: [await generateSigningKey("ES256", `reports-${++generation}`)],
    clients: [{
      client_id: "reports-service",
      jwks: { keys: [{ ...publicJwk(client), kid: "service-client" }] },
      grant_types: ["client_credentials"],
      scope: "reports:read",
    }],
    scopesSupported: ["reports:read", "reports:write"],
    resources: { allowed: [api] },
  });
  const resource = testResourceServer(as, {
    resource: api,
    scopesSupported: ["reports:read"],
  });
  return {
    as,
    api: serveResource(
      resource,
      (_request, principal) =>
        Response.json({
          report: "daily",
          rows: [{ region: "north", orders: 42 }],
          for: principal.clientId,
        }),
      { scopes: ["reports:read"] },
    ),
  };
}

serveUpstream({
  async fetch(request) {
    current ??= site();
    const { as, api } = await current;
    const path = new URL(request.url).pathname;
    const answer = scripted(path);
    if (answer !== null) return answer;
    if (path.startsWith("/api") || path.includes("oauth-protected-resource")) {
      return await api(request);
    }
    return await as.handle(request);
  },
  script(instruction) {
    const step = instruction as {
      rotate?: boolean;
      answer?: "redirect" | "huge";
    };
    if (step.rotate) current = site();
    if (step.answer !== undefined) next = step.answer;
  },
  vars(listening) {
    origin = listening;
    return {
      SERVICE_ISSUER: `${listening}/as`,
      REPORTS_API: `${listening}/api`,
      CLIENT_ID: "reports-service",
      CLIENT_JWK,
      // This fake runs on http://127.0.0.1: discovery may reach it only
      // through the named development override.
      OAUTH_LOOPBACK_FOR_DEVELOPMENT: "true",
    };
  },
});

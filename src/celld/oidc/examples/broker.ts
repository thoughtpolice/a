// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * A broker: an OpenID Provider whose users log in at another provider
 * upstream. Downstream clients see only the broker; the broker is a
 * relying party upstream, with its own DPoP key.
 *
 * - The provider's endpoints at this origin (`/.well-known/openid-configuration`,
 *   `/par`, `/authorize`, `/token`, `/userinfo`, `/introspect`, ...).
 * - `/authorize` sends the browser upstream (`UpstreamBroker.begin`: the
 *   upstream request pushed with the broker's DPoP key thumbprint as
 *   `dpop_jkt`, the pending login in the sealed `oidc-broker` cookie).
 * - `GET /upstream/callback`: `UpstreamBroker.finish`: the upstream code
 *   redeemed with the broker's DPoP proof, the upstream ID token
 *   validated, upstream UserInfo read with DPoP, and the downstream
 *   authorization resumed as `upstream:<sub>` with the upstream's
 *   `auth_time`, `acr` and `amr`.
 * - Token exchange (`boundTokenExchange`): a client exchanges its own
 *   access token for one for `https://api.example`, never with more scope,
 *   and a DPoP-bound one only by proving the same key.
 *
 * What is bound to what: the upstream code and tokens are bound to the
 * broker's key (`BROKER_DPOP_JWK`) and never leave the broker (they are
 * kept, with the upstream claims, in the `OAuthRecords` Durable Object,
 * which a real deployment would encrypt). Downstream tokens are bound to
 * the downstream client's own key when it sends proofs. This example's
 * downstream client is the test spec, which cannot sign proofs, so it is a
 * public client with Bearer tokens; `tests/flow_test.ts` runs DPoP on
 * both hops, through a federation.
 *
 * Settings: the upstream (`UPSTREAM_ISSUER`, `UPSTREAM_CLIENT_ID`,
 * `UPSTREAM_CLIENT_SECRET`), and secrets for the broker's signing key and
 * DPoP key (private JWKs as JSON: `SIGNING_JWK`, `BROKER_DPOP_JWK`)
 * and cookie (`COOKIE_SECRET`).
 *
 * ```sh
 * buck2 run root//src/celld/oidc/examples:broker-dev
 * curl -sS localhost:9876/.well-known/openid-configuration
 * ```
 *
 * @module
 */

import type { Jwk } from "@celld/jwt";
import { ProtocolError } from "@celld/oauth";
import { DpopKey } from "@celld/oauth/dpop";
import { durableRecordStore, type RecordStoreApi } from "@celld/oauth/durable";
import { signingKeyFromJwk } from "@celld/oauth/server";
import { boundTokenExchange, UpstreamBroker } from "@celld/oidc/broker";
import { OpenIdProvider } from "@celld/oidc/provider";
import { CookieSealer, OidcClient } from "@celld/oidc/rp";

export { OAuthRecords } from "@celld/oauth/durable";

interface Env {
  readonly OAUTH_RECORDS: DurableObjectNamespace<RecordStoreApi>;
  readonly UPSTREAM_ISSUER: string;
  readonly UPSTREAM_CLIENT_ID: string;
  readonly UPSTREAM_CLIENT_SECRET: string;
  readonly SIGNING_JWK: string;
  readonly BROKER_DPOP_JWK: string;
  readonly COOKIE_SECRET: string;
  readonly INTROSPECTION_SECRET: string;
}

interface Broker {
  readonly provider: OpenIdProvider;
  readonly upstream: UpstreamBroker;
}

const API = "https://api.example";
const brokers = new Map<string, Promise<Broker>>();

function jwk(text: string): Jwk {
  return JSON.parse(text);
}

async function build(origin: string, env: Env): Promise<Broker> {
  const store = durableRecordStore(env.OAUTH_RECORDS);
  const upstream = new UpstreamBroker({
    upstream: new OidcClient({
      issuer: env.UPSTREAM_ISSUER,
      client: {
        method: "client_secret_basic",
        clientId: env.UPSTREAM_CLIENT_ID,
        clientSecret: env.UPSTREAM_CLIENT_SECRET,
      },
      redirectUri: `${origin}/upstream/callback`,
      dpop: await DpopKey.fromPrivateJwk(jwk(env.BROKER_DPOP_JWK), "ES256"),
    }),
    sealer: await CookieSealer.create({ secret: env.COOKIE_SECRET }),
    store,
    scope: ["profile", "email"],
    subject: (claims) => `upstream:${claims.sub}`,
    secure: origin.startsWith("https:"),
  });
  const provider = new OpenIdProvider({
    issuer: origin,
    keys: [await signingKeyFromJwk(jwk(env.SIGNING_JWK), "ES256")],
    store,
    clients: [
      {
        client_id: "app",
        redirect_uris: ["http://127.0.0.1/cb"],
        grant_types: [
          "authorization_code",
          "refresh_token",
          "urn:ietf:params:oauth:grant-type:token-exchange",
        ],
      },
      {
        client_id: "api",
        client_secret: env.INTROSPECTION_SECRET,
        grant_types: [],
      },
    ],
    resources: { allowed: [API] },
    tokenExchange: boundTokenExchange(),
    interaction: (context) =>
      context.prompt.includes("none")
        ? { deny: { error: "login_required" } }
        : upstream.begin(
          context.interactionId,
          context.maxAge === undefined ? {} : { maxAge: context.maxAge },
        ),
    claims: ({ subject, claims }) => upstream.claims(subject, claims),
  });
  return { provider, upstream };
}

function broker(origin: string, env: Env): Promise<Broker> {
  let found = brokers.get(origin);
  if (found === undefined) {
    found = build(origin, env);
    brokers.set(origin, found);
  }
  return found;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const { provider, upstream } = await broker(url.origin, env);
    if (url.pathname === "/upstream/callback") {
      try {
        return await upstream.finish(provider, request, {
          sessionId: OpenIdProvider.newSessionId(),
        });
      } catch (error) {
        if (error instanceof ProtocolError) return error.toResponse();
        throw error;
      }
    }
    return await provider.handle(request) ??
      new Response("not found", { status: 404 });
  },
};

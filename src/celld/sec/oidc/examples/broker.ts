// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * A broker: an OpenID Provider whose users log in at another provider
 * upstream. Downstream clients see only the broker; the broker is a
 * relying party upstream, with its own DPoP key.
 *
 * - The provider's endpoints (`/.well-known/openid-configuration`,
 *   `/par`, `/authorize`, `/token`, `/userinfo`, `/introspect`, ...). The
 *   issuer (and the upstream redirect URI's origin) is `ISSUER`, which a
 *   deployment sets; without it (development only) it is the request's
 *   origin, and only when its host is a loopback IP literal, so a `Host`
 *   header cannot name a new issuer.
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
 * encrypted at rest with AES-256-GCM under `BROKER_SECRET` by
 * `encryptedSecretStore`). Downstream tokens are bound to
 * the downstream client's own key when it sends proofs. This example's
 * downstream client is the test spec, which cannot sign proofs, so it is a
 * public client with Bearer tokens; `tests/flow_test.ts` runs DPoP on
 * both hops, through a federation.
 *
 * Settings: the issuer (`ISSUER`), the upstream (`UPSTREAM_ISSUER`,
 * `UPSTREAM_CLIENT_ID`, `UPSTREAM_CLIENT_SECRET`), and secrets for the
 * broker's signing key and DPoP key (private JWKs as JSON: `SIGNING_JWK`,
 * `BROKER_DPOP_JWK`), cookie (`COOKIE_SECRET`), upstream token encryption
 * (`BROKER_SECRET`), the `api` client's introspection secret
 * (`INTROSPECTION_SECRET`) and the `sid` claim's key (`SESSION_SID_KEY`).
 * `UPSTREAM_LOOPBACK_FOR_DEVELOPMENT="true"` allows an upstream on
 * http://127.0.0.1; it is for development only, and the spec's fake sets
 * it.
 *
 * ```sh
 * buck2 run root//src/celld/sec/oidc/examples:broker-dev
 * curl -sS localhost:9876/.well-known/openid-configuration
 * ```
 *
 * @module
 */

import type { Jwk } from "@celld/sec/jwt";
import { ProtocolError } from "@celld/sec/oauth";
import { DpopKey } from "@celld/sec/oauth/dpop";
import {
  durableRecordStore,
  type RecordStoreApi,
} from "@celld/sec/oauth/durable";
import { signingKeyFromJwk } from "@celld/sec/oauth/server";
import {
  boundTokenExchange,
  encryptedSecretStore,
  UpstreamBroker,
} from "@celld/sec/oidc/broker";
import { OpenIdProvider } from "@celld/sec/oidc/provider";
import { CookieSealer, OidcClient } from "@celld/sec/oidc/rp";

export { OAuthRecords } from "@celld/sec/oauth/durable";

interface Env {
  readonly OAUTH_RECORDS: DurableObjectNamespace<RecordStoreApi>;
  readonly UPSTREAM_ISSUER: string;
  readonly UPSTREAM_CLIENT_ID: string;
  readonly UPSTREAM_CLIENT_SECRET: string;
  readonly SIGNING_JWK: string;
  readonly BROKER_DPOP_JWK: string;
  readonly COOKIE_SECRET: string;
  /** 32 random bytes (base64url); encrypts the upstream tokens in the record store. */
  readonly BROKER_SECRET: string;
  readonly INTROSPECTION_SECRET: string;
  /** `"true"` only for an upstream on http://127.0.0.1 during development. */
  readonly UPSTREAM_LOOPBACK_FOR_DEVELOPMENT?: string;
  /** 32 random bytes (base64url); keys the `sid` claim (`OpenIdProvider.sessionSid`). */
  readonly SESSION_SID_KEY: string;
  /** The issuer origin, such as `https://login.example.com`; a deployment sets it. */
  readonly ISSUER?: string;
}

interface Broker {
  readonly provider: OpenIdProvider;
  readonly upstream: UpstreamBroker;
}

const API = "https://api.example";
/** The one broker, for the one issuer; never one per `Host`. */
let current:
  | { readonly issuer: string; readonly broker: Promise<Broker> }
  | null = null;

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
      allowLoopbackForDevelopment:
        env.UPSTREAM_LOOPBACK_FOR_DEVELOPMENT === "true",
    }),
    sealer: await CookieSealer.create({ secret: env.COOKIE_SECRET }),
    secrets: await encryptedSecretStore(store, { secret: env.BROKER_SECRET }),
    scope: ["profile", "email"],
    subject: (claims) => `upstream:${claims.sub}`,
    secure: origin.startsWith("https:"),
  });
  const provider = new OpenIdProvider({
    issuer: origin,
    keys: [await signingKeyFromJwk(jwk(env.SIGNING_JWK), "ES256")],
    store,
    sessionSidKey: env.SESSION_SID_KEY,
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
    // The API may introspect tokens for itself and for UserInfo (the
    // default audience), and sees how the user authenticated upstream.
    introspection: {
      audiences: { api: [API, `${origin}/userinfo`] },
      claims: ["acr", "amr"],
    },
    tokenExchange: boundTokenExchange({
      sourceAudiences: [API, `${origin}/userinfo`],
    }),
    interaction: (context) =>
      context.prompt.includes("none")
        ? { deny: { error: "login_required" } }
        : upstream.begin(
          context.interactionId,
          context.request,
          context.maxAge === undefined ? {} : { maxAge: context.maxAge },
        ),
    claims: ({ subject, claims }) => upstream.claims(subject, claims),
  });
  return { provider, upstream };
}

function isLoopbackLiteral(hostname: string): boolean {
  return hostname === "[::1]" ||
    /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(hostname);
}

/**
 * The issuer: `ISSUER` when set. Otherwise, for development, the request's
 * origin when its host is a loopback IP literal, and null for any other
 * host (which is refused).
 */
function issuerOf(url: URL, env: Env): string | null {
  if (env.ISSUER !== undefined && env.ISSUER !== "") {
    const origin = new URL(env.ISSUER).origin;
    return url.origin === origin ? origin : null;
  }
  return isLoopbackLiteral(url.hostname) ? url.origin : null;
}

function broker(issuer: string, env: Env): Promise<Broker> {
  if (current === null || current.issuer !== issuer) {
    current = { issuer, broker: build(issuer, env) };
  }
  return current.broker;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const issuer = issuerOf(url, env);
    if (issuer === null) {
      return new Response("not this provider's host", { status: 421 });
    }
    const { provider, upstream } = await broker(issuer, env);
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

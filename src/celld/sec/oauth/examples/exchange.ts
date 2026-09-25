// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * Token exchange (RFC 8693): an API gateway trades the token a caller
 * sent it for a narrower one that a backend accepts, and the new token
 * says who acted.
 *
 * - `POST /token` with `client_credentials`: the `web` app gets a token
 *   for the gateway (`/gateway`) with `orders:read orders:write`.
 * - `POST /token` with the token exchange grant: the `gateway` client
 *   presents that token as `subject_token` and names a backend by
 *   `audience` (`orders` or `billing`); it gets an access token for that
 *   backend with the same subject, at most the subject token's scopes
 *   (none unless explicitly requested), and `act: {"sub": "gateway"}`.
 * - `POST /introspect`: what a backend would learn about a token. The
 *   `introspection` policy lets `gateway` see tokens for the backends,
 *   `act` included, and nobody else see anything.
 *
 * The exchange policy is the host's `tokenExchange` hook, below. It
 * refuses a subject token this server did not issue or that is revoked
 * (`invalid_grant`), a client that is not a known actor
 * (`unauthorized_client`), a backend it does not know (`invalid_target`)
 * and scopes the subject token lacks (`invalid_scope`). A DPoP-bound
 * subject token is only exchanged by a request proving the same key
 * (`context.jkt`, the thumbprint of the request's proof, must be its
 * `cnf.jkt`), so a stolen bound token cannot be traded for a bearer one;
 * `@celld/sec/oidc`'s `boundTokenExchange` and its tests cover that path
 * end to end. The server itself refuses `requested_token_type`s other
 * than access tokens.
 *
 * Clients authenticate with `client_secret_basic`; their secrets and the
 * signing key (`SIGNING_JWK`, a JWK as JSON) come from the environment.
 * The issuer is `ISSUER` when set, as a deployment must; without it
 * (development) it is the request's origin, and only a loopback address
 * is served, so the `Host` header cannot pick an issuer (421 otherwise).
 *
 * ```sh
 * buck2 run root//src/celld/sec/oauth/examples:exchange-dev
 * curl -sS -u web:web-secret-0123456789 127.0.0.1:9876/token \
 *   -d grant_type=client_credentials -d 'scope=orders:read orders:write'
 * ```
 *
 * @module
 */

import type { Jwk } from "@celld/sec/jwt";
import { ProtocolError } from "@celld/sec/oauth";
import {
  durableRecordStore,
  type RecordStoreApi,
} from "@celld/sec/oauth/durable";
import {
  AuthorizationServer,
  signingKeyFromJwk,
  type TokenExchangePolicy,
} from "@celld/sec/oauth/server";

export { OAuthRecords } from "@celld/sec/oauth/durable";

interface Env {
  readonly OAUTH_RECORDS: DurableObjectNamespace<RecordStoreApi>;
  readonly SIGNING_JWK: string;
  readonly WEB_SECRET: string;
  readonly GATEWAY_SECRET: string;
  readonly STRANGER_SECRET: string;
  /** The issuer (this Worker's public origin); a deployment sets it. */
  readonly ISSUER?: string;
}

/** The clients that may exchange tokens issued to someone else. */
const ACTORS = ["gateway"];

/** The one server this isolate runs, for its one issuer. */
let current: {
  readonly issuer: string;
  readonly server: Promise<AuthorizationServer>;
} | null = null;

/**
 * The issuer for `url`: `ISSUER` when set; otherwise the request's origin,
 * but only on a loopback address (development). Null for anything else.
 */
function issuerFor(url: URL, env: Env): string | null {
  if (env.ISSUER !== undefined && env.ISSUER !== "") return env.ISSUER;
  return /^(127\.\d{1,3}\.\d{1,3}\.\d{1,3}|\[::1\])$/.test(url.hostname)
    ? url.origin
    : null;
}

/**
 * The backends a token can be exchanged for, by name. A `Map`, so a name
 * from the request such as `constructor` is not an `Object.prototype`
 * member.
 */
function backendsOf(origin: string): ReadonlyMap<string, string> {
  return new Map([
    ["orders", `${origin}/orders`],
    ["billing", `${origin}/billing`],
  ]);
}

function exchangePolicy(origin: string): TokenExchangePolicy["authorize"] {
  const backends = backendsOf(origin);
  return (context) => {
    // The safe policy has already verified issuer, source audience, expiry,
    // proof key, actor depth and requested scope attenuation.
    const claims = context.subject;
    if (!ACTORS.includes(context.client.client_id)) {
      throw new ProtocolError("unauthorized_client", {
        description: "this client may not act for others",
      });
    }
    if (context.audience.length === 0) {
      throw new ProtocolError("invalid_target", {
        description: "name an audience",
      });
    }
    const audience = context.audience.map((name) => {
      const backend = backends.get(name);
      if (backend === undefined) {
        throw new ProtocolError("invalid_target", {
          description: `no backend called ${name}`,
        });
      }
      return backend;
    });
    return Promise.resolve({
      subject: claims.sub as string,
      scope: context.scope,
      audience,
      act: {
        sub: context.client.client_id,
        ...(claims.act === undefined ? {} : { act: claims.act }),
      },
    });
  };
}

async function build(origin: string, env: Env): Promise<AuthorizationServer> {
  const jwk = JSON.parse(env.SIGNING_JWK) as Jwk;
  const exchange = "urn:ietf:params:oauth:grant-type:token-exchange";
  return new AuthorizationServer({
    issuer: origin,
    keys: [await signingKeyFromJwk(jwk, "ES256")],
    store: durableRecordStore(env.OAUTH_RECORDS),
    clients: [
      {
        client_id: "web",
        client_secret: env.WEB_SECRET,
        grant_types: ["client_credentials"],
        scope: "orders:read orders:write",
      },
      {
        client_id: "gateway",
        client_secret: env.GATEWAY_SECRET,
        grant_types: [exchange],
      },
      {
        client_id: "stranger",
        client_secret: env.STRANGER_SECRET,
        grant_types: [exchange],
      },
    ],
    scopesSupported: ["orders:read", "orders:write", "orders:delete"],
    resources: {
      default: [`${origin}/gateway`],
      allowed: [`${origin}/gateway`, `${origin}/orders`, `${origin}/billing`],
    },
    tokenExchange: {
      sourceAudiences: [`${origin}/gateway`],
      authorize: exchangePolicy(origin),
    },
    introspection: {
      audiences: { gateway: [...backendsOf(origin).values()] },
      claims: ["act"],
    },
    interaction: () => ({
      deny: { description: "this server has no browser flow" },
    }),
  });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const issuer = issuerFor(new URL(request.url), env);
    if (issuer === null) {
      return new Response("not an issuer here", { status: 421 });
    }
    if (current?.issuer !== issuer) {
      current = { issuer, server: build(issuer, env) };
    }
    return await (await current.server).handle(request) ??
      new Response("not found", { status: 404 });
  },
};

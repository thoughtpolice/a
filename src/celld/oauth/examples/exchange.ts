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
 *   (default all of them), and `act: {"sub": "gateway"}`.
 * - `POST /introspect`: what a backend would learn about a token (any of
 *   the confidential clients may ask).
 *
 * The exchange policy is the host's `tokenExchange` hook, below. It
 * refuses a subject token this server did not issue or that is revoked
 * (`invalid_grant`), a client that is not a known actor
 * (`unauthorized_client`), a backend it does not know (`invalid_target`)
 * and scopes the subject token lacks (`invalid_scope`). A DPoP-bound
 * subject token is only exchanged by a request proving the same key
 * (`context.jkt`, the thumbprint of the request's proof, must be its
 * `cnf.jkt`), so a stolen bound token cannot be traded for a bearer one;
 * `@celld/oidc`'s `boundTokenExchange` and its tests cover that path
 * end to end. The server itself refuses `requested_token_type`s other
 * than access tokens.
 *
 * Clients authenticate with `client_secret_basic`; their secrets and the
 * signing key (`SIGNING_JWK`, a JWK as JSON) come from the environment.
 *
 * ```sh
 * buck2 run root//src/celld/oauth/examples:exchange-dev
 * curl -sS -u web:web-secret-0123456789 localhost:9876/token \
 *   -d grant_type=client_credentials -d 'scope=orders:read orders:write'
 * ```
 *
 * @module
 */

import type { Jwk } from "@celld/jwt";
import { parseScope, ProtocolError, TOKEN_TYPES } from "@celld/oauth";
import { durableRecordStore, type RecordStoreApi } from "@celld/oauth/durable";
import {
  AuthorizationServer,
  signingKeyFromJwk,
  type TokenExchangeHook,
} from "@celld/oauth/server";

export { OAuthRecords } from "@celld/oauth/durable";

interface Env {
  readonly OAUTH_RECORDS: DurableObjectNamespace<RecordStoreApi>;
  readonly SIGNING_JWK: string;
  readonly WEB_SECRET: string;
  readonly GATEWAY_SECRET: string;
  readonly STRANGER_SECRET: string;
}

/** The clients that may exchange tokens issued to someone else. */
const ACTORS = ["gateway"];

const servers = new Map<string, Promise<AuthorizationServer>>();

function exchangePolicy(origin: string): TokenExchangeHook {
  const backends: Readonly<Record<string, string>> = {
    orders: `${origin}/orders`,
    billing: `${origin}/billing`,
  };
  return async (context) => {
    if (context.subjectTokenType !== TOKEN_TYPES.accessToken) {
      throw new ProtocolError("invalid_request", {
        description: "only access tokens are exchanged here",
      });
    }
    const claims = await context.verifyAccessToken(context.subjectToken);
    if (claims === null) return null;
    const bound = (claims.cnf as { jkt?: string } | undefined)?.jkt;
    if (bound !== undefined && context.jkt !== bound) {
      throw new ProtocolError("invalid_grant", {
        description:
          "the subject token is DPoP-bound to a key the request did not prove",
      });
    }
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
      const backend = backends[name];
      if (backend === undefined) {
        throw new ProtocolError("invalid_target", {
          description: `no backend called ${name}`,
        });
      }
      return backend;
    });
    const granted = parseScope(claims.scope as string | undefined);
    for (const scope of context.scope) {
      if (!granted.includes(scope)) {
        throw new ProtocolError("invalid_scope", {
          description: `the subject token does not carry ${scope}`,
        });
      }
    }
    return {
      subject: claims.sub as string,
      scope: context.scope.length > 0 ? context.scope : granted,
      audience,
      act: {
        sub: context.client.client_id,
        ...(claims.act === undefined ? {} : { act: claims.act }),
      },
    };
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
    resources: { default: [`${origin}/gateway`] },
    tokenExchange: exchangePolicy(origin),
    interaction: () => ({
      deny: { description: "this server has no browser flow" },
    }),
  });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    let server = servers.get(url.origin);
    if (server === undefined) {
      server = build(url.origin, env);
      servers.set(url.origin, server);
    }
    return await (await server).handle(request) ??
      new Response("not found", { status: 404 });
  },
};

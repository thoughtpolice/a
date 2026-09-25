// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * A Worker that runs `@celld/oidc` on the real celld runtime: an OpenID
 * Provider under `/op` whose records (codes, refresh families, login
 * sessions, DPoP `jti`s) live in `@celld/oauth`'s `OAuthRecords` Durable
 * Object, a two-entity federation (`/ta` over `/leaf`) whose fetched
 * statements are cached in the same objects, and routes that drive a
 * relying party against them. `tests/runtime_test.py` calls the routes
 * and restarts the supervisor between calls to check what must survive.
 *
 * The relying party reaches the provider in process, since the Worker
 * would otherwise call itself. Keys are made per isolate, so a restart
 * rotates them: the provider's refresh tokens and ended sessions, which
 * are records, survive; the federation's cached statements, signed with
 * the old keys, must be refetched.
 *
 * @module
 */

import { DpopKey } from "@celld/oauth/dpop";
import { durableRecordStore, type RecordStoreApi } from "@celld/oauth/durable";
import { generateSigningKey, type SigningKey } from "@celld/oauth/server";
import { routeFetch } from "@celld/oauth/testing";
import type { IdTokenClaims } from "@celld/oidc";
import {
  FederationEntity,
  federationJwks,
  TrustChainResolver,
} from "@celld/oidc/federation";
import { OpenIdProvider } from "@celld/oidc/provider";
import { OidcClient } from "@celld/oidc/rp";
import { testBrowser } from "@celld/oidc/testing";

export { OAuthRecords } from "@celld/oauth/durable";

interface Env {
  OAUTH_RECORDS: DurableObjectNamespace<RecordStoreApi>;
}

interface World {
  readonly issuer: string;
  readonly provider: OpenIdProvider;
  readonly fetch: ReturnType<typeof routeFetch>;
  readonly anchor: FederationEntity;
  readonly leaf: FederationEntity;
  readonly env: Env;
}

let keys: Promise<SigningKey[]> | null = null;
const worlds = new Map<string, Promise<World>>();

async function build(origin: string, env: Env): Promise<World> {
  keys ??= Promise.all([
    generateSigningKey("ES256", "op"),
    generateSigningKey("ES256", "ta"),
    generateSigningKey("ES256", "leaf"),
  ]);
  const [opKey, taKey, leafKey] = await keys;
  const issuer = `${origin}/op`;
  const provider = new OpenIdProvider({
    issuer,
    keys: [opKey],
    store: durableRecordStore(env.OAUTH_RECORDS),
    clients: [{
      client_id: "app",
      redirect_uris: ["http://127.0.0.1/cb"],
      post_logout_redirect_uris: ["http://127.0.0.1/bye"],
    }],
    interaction: () => ({
      grant: {
        subject: "runtime-user",
        authTime: Math.floor(Date.now() / 1000),
        sessionId: "runtime-session",
      },
    }),
    claims: () => ({ email: "runtime@example.com", email_verified: true }),
  });
  const anchor = new FederationEntity({
    entityId: `${origin}/ta`,
    keys: [taKey],
    subordinates: {
      [`${origin}/leaf`]: {
        jwks: federationJwks([leafKey]),
        metadataPolicy: {
          openid_relying_party: { contacts: { add: ["ta@example.com"] } },
        },
      },
    },
  });
  const leaf = new FederationEntity({
    entityId: `${origin}/leaf`,
    keys: [leafKey],
    authorityHints: [`${origin}/ta`],
    metadata: {
      openid_relying_party: {
        redirect_uris: ["http://127.0.0.1/leaf/cb"],
        contacts: ["leaf@example.com"],
      },
    },
  });
  const fetch = routeFetch({
    [origin]: async (request) =>
      await anchor.handle(request) ?? await leaf.handle(request) ??
        await provider.handle(request) ??
        new Response("not found", { status: 404 }),
  });
  return { issuer, provider, fetch, anchor, leaf, env };
}

function world(url: URL, env: Env): Promise<World> {
  let found = worlds.get(url.origin);
  if (found === undefined) {
    found = build(url.origin, env);
    worlds.set(url.origin, found);
  }
  return found;
}

function client(w: World, dpop?: DpopKey): OidcClient {
  return new OidcClient({
    issuer: w.issuer,
    client: { method: "none", clientId: "app" },
    redirectUri: "http://127.0.0.1/cb",
    fetch: w.fetch,
    dpop,
  });
}

async function login(w: World, dpop: boolean): Promise<Response> {
  const rp = client(w, dpop ? await DpopKey.generate() : undefined);
  const pending = await rp.authorizationUrl({ scope: ["email"], maxAge: 300 });
  const callback = await testBrowser(w.fetch).navigate(
    pending.authorization.url,
    "http://127.0.0.1/cb",
  );
  const done = await rp.completeLogin(pending, callback);
  return Response.json({
    subject: done.subject,
    tokenType: done.tokens.token_type,
    sid: done.claims.sid,
    claims: done.claims,
    userinfo: await rp.userinfo(done.tokens, done.subject),
    refreshToken: done.tokens.refresh_token,
  });
}

async function refresh(w: World, request: Request): Promise<Response> {
  const { refreshToken, claims } = await request.json() as {
    refreshToken: string;
    claims: IdTokenClaims;
  };
  try {
    const result = await client(w).refresh(refreshToken, claims);
    return Response.json({
      ok: true,
      refreshToken: result.tokens.refresh_token,
      idToken: result.tokens.id_token,
      claims: result.claims,
    });
  } catch (error) {
    return Response.json({
      ok: false,
      error: (error as { error?: string }).error ?? String(error),
    });
  }
}

async function logout(w: World, request: Request): Promise<Response> {
  const { idToken } = await request.json() as { idToken: string };
  const url = await client(w).logoutUrl({
    idTokenHint: idToken,
    postLogoutRedirectUri: "http://127.0.0.1/bye",
    state: "bye",
  });
  const response = await w.fetch(url);
  return Response.json({
    status: response.status,
    location: response.headers.get("location"),
  });
}

async function federation(w: World, origin: string): Promise<Response> {
  const resolver = new TrustChainResolver({
    trustAnchors: [{ entityId: w.anchor.entityId, jwks: w.anchor.jwks }],
    fetch: w.fetch,
    cache: durableRecordStore(w.env.OAUTH_RECORDS, { name: "federation" }),
  });
  const before = w.fetch.requests.length;
  const chain = await resolver.resolve(`${origin}/leaf`);
  return Response.json({
    metadata: chain.metadata,
    statements: chain.statements.length,
    fetches: w.fetch.requests.length - before,
  });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const w = await world(url, env);
    switch (`${request.method} ${url.pathname}`) {
      case "GET /login":
        return await login(w, url.searchParams.get("dpop") === "1");
      case "POST /refresh":
        return await refresh(w, request);
      case "POST /logout":
        return await logout(w, request);
      case "GET /federation":
        return await federation(w, url.origin);
    }
    return await w.anchor.handle(request) ?? await w.leaf.handle(request) ??
      await w.provider.handle(request) ??
      new Response("not found", { status: 404 });
  },
};

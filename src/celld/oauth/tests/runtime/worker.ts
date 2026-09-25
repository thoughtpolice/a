// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * A Worker that runs `@celld/oauth` on the real celld runtime: an
 * authorization server under `/as` whose records live in the
 * `OAuthRecords` Durable Object, a resource under `/api` with DPoP replay
 * prevention in the same objects, and routes that drive a client against
 * both. `tests/runtime_test.py` calls the routes over HTTP and restarts the
 * supervisor between calls to check what must survive.
 *
 * The client reaches the servers in process, not over the network, since
 * the Worker would otherwise call itself. The servers' keys are made per
 * isolate, so access tokens do not outlive a restart; refresh tokens,
 * which are records, do.
 *
 * @module
 */

import { OAuthClient, OAuthSession } from "@celld/oauth/client";
import { DpopKey, DpopNonceIssuer } from "@celld/oauth/dpop";
import {
  durableRecordStore,
  durableReplayStore,
  type RecordStoreApi,
} from "@celld/oauth/durable";
import { jwtAccessTokenVerifier, ResourceServer } from "@celld/oauth/resource";
import {
  AuthorizationServer,
  generateSigningKey,
  publicJwks,
  type SigningKey,
} from "@celld/oauth/server";
import { routeFetch, testUserAgent } from "@celld/oauth/testing";

export { OAuthRecords } from "@celld/oauth/durable";

interface Env {
  OAUTH_RECORDS: DurableObjectNamespace<RecordStoreApi>;
  NONCE_SECRET: string;
}

interface World {
  readonly issuer: string;
  readonly api: string;
  readonly server: AuthorizationServer;
  readonly resource: ResourceServer;
  readonly fetch: ReturnType<typeof routeFetch>;
}

let keys: Promise<SigningKey[]> | null = null;
const worlds = new Map<string, Promise<World>>();

async function build(origin: string, env: Env): Promise<World> {
  keys ??= generateSigningKey("ES256").then((key) => [key]);
  const issuer = `${origin}/as`;
  const api = `${origin}/api`;
  const store = durableRecordStore(env.OAUTH_RECORDS);
  const nonce = await DpopNonceIssuer.create({ secret: env.NONCE_SECRET });
  const server = new AuthorizationServer({
    issuer,
    keys: await keys,
    store,
    clients: [
      { client_id: "app", redirect_uris: ["http://127.0.0.1/cb"] },
    ],
    resources: { allowed: [api] },
    dpop: { nonce },
    interaction: () => ({ grant: { subject: "runtime-user" } }),
  });
  const resource = new ResourceServer({
    resource: api,
    authorizationServers: [issuer],
    verifier: jwtAccessTokenVerifier({
      issuer,
      audience: api,
      keys: publicJwks(await keys),
    }),
    dpop: { replay: durableReplayStore(env.OAUTH_RECORDS), nonce },
  });
  const handleApi = async (request: Request) => {
    const metadata = resource.handleMetadata(request);
    if (metadata !== null) return metadata;
    const result = await resource.verifyRequest(request);
    if (!result.ok) return result.challenge.toResponse();
    return Response.json(result.principal, { headers: result.headers });
  };
  const fetch = routeFetch({
    [origin]: async (request) => {
      const path = new URL(request.url).pathname;
      if (
        path.startsWith("/api") || path.includes("oauth-protected-resource")
      ) {
        return await handleApi(request);
      }
      return await server.handle(request) ??
        new Response("not found", { status: 404 });
    },
  });
  return { issuer, api, server, resource, fetch };
}

function world(url: URL, env: Env): Promise<World> {
  let found = worlds.get(url.origin);
  if (found === undefined) {
    found = build(url.origin, env);
    worlds.set(url.origin, found);
  }
  return found;
}

async function flow(w: World, dpop: boolean): Promise<Response> {
  const key = dpop ? await DpopKey.generate() : undefined;
  const session = new OAuthSession({
    resource: w.api,
    redirectUri: "http://127.0.0.1/cb",
    registration: { preregistered: { [w.issuer]: { client_id: "app" } } },
    userAgent: testUserAgent(w.fetch),
    fetch: w.fetch,
    dpop: key,
  });
  const response = await session.fetch(`${w.api}/whoami`);
  const tokens = await session.tokens();
  return Response.json({
    status: response.status,
    principal: await response.json(),
    tokenType: tokens?.token_type,
    refreshToken: tokens?.refresh_token,
    requests: w.fetch.requests.length,
  });
}

async function refresh(w: World, request: Request): Promise<Response> {
  const { refreshToken } = await request.json() as { refreshToken: string };
  const client = new OAuthClient({
    issuer: w.issuer,
    client: { method: "none", clientId: "app" },
    fetch: w.fetch,
  });
  try {
    const tokens = await client.refresh(refreshToken, { resource: w.api });
    return Response.json({ ok: true, refreshToken: tokens.refresh_token });
  } catch (error) {
    return Response.json({
      ok: false,
      error: (error as { error?: string }).error ?? String(error),
    });
  }
}

async function replay(w: World): Promise<Response> {
  const key = await DpopKey.generate();
  const session = new OAuthSession({
    resource: w.api,
    redirectUri: "http://127.0.0.1/cb",
    registration: { preregistered: { [w.issuer]: { client_id: "app" } } },
    userAgent: testUserAgent(w.fetch),
    fetch: w.fetch,
    dpop: key,
  });
  await session.authorize();
  const url = `${w.api}/whoami`;
  let headers = await session.headers({ method: "GET", url });
  let first = await w.fetch(url, { headers });
  if (first.status === 401) {
    // The resource's nonce, then a fresh proof carrying it.
    await session.challenge({
      status: 401,
      headers: first.headers,
      method: "GET",
      url,
      attempt: 1,
    });
    headers = await session.headers({ method: "GET", url });
    first = await w.fetch(url, { headers });
  }
  const second = await w.fetch(url, { headers });
  return Response.json({
    first: first.status,
    second: second.status,
    secondError: second.headers.get("www-authenticate"),
  });
}

async function records(env: Env): Promise<Response> {
  const store = durableRecordStore(env.OAUTH_RECORDS, { name: "runtime" });
  const key = `k-${crypto.randomUUID()}`;
  const created = await store.create(key, { n: 1 }, Date.now() + 60_000);
  const again = await store.create(key, { n: 2 }, null);
  const record = await store.get<{ n: number }>(key);
  const stale = await store.swap(key, 99, { n: 3 }, null);
  const swapped = await store.swap(key, record!.version, { n: 4 }, null);
  const after = await store.get<{ n: number }>(key);
  const expired = `e-${crypto.randomUUID()}`;
  await store.put(expired, 1, Date.now() - 1);
  return Response.json({
    created,
    again,
    record,
    stale,
    swapped,
    after,
    expired: await store.get(expired),
  });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const w = await world(url, env);
    switch (url.pathname) {
      case "/flow":
        return await flow(w, url.searchParams.get("dpop") === "1");
      case "/refresh":
        return await refresh(w, request);
      case "/replay":
        return await replay(w);
      case "/records":
        return await records(env);
    }
    return await w.fetch(request);
  },
};

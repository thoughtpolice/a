// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

import { assert, assertEquals } from "@celld/assert";
import { decode } from "@celld/jwt";
import {
  memoryOAuthStore,
  OAuthSession,
  type OAuthSessionOptions,
} from "@celld/oauth/client";
import { DpopKey, DpopNonceIssuer, memoryReplayStore } from "@celld/oauth/dpop";
import type {
  ResourceDpopOptions,
  ResourceServer,
} from "@celld/oauth/resource";
import type { AuthorizationServerOptions } from "@celld/oauth/server";
import {
  routeFetch,
  testResourceServer,
  testUserAgent,
} from "@celld/oauth/testing";
import { API, ISSUER, rejects, SECRET, type World, world } from "./fixture.ts";

interface Setup {
  readonly w: World;
  readonly api: ResourceServer;
  readonly fetch: ReturnType<typeof routeFetch>;
  readonly agent: ReturnType<typeof testUserAgent>;
  session(options?: Partial<OAuthSessionOptions>): OAuthSession;
}

/** An authorization server, a resource needing `read` (and `write` to POST), and a session factory. */
async function setup(
  options: {
    readonly asDpop?: AuthorizationServerOptions["dpop"];
    readonly rsDpop?: ResourceDpopOptions | false;
    readonly registration?: boolean;
  } = {},
): Promise<Setup> {
  const w = await world({
    ...(options.asDpop === undefined ? {} : { dpop: options.asDpop }),
    ...(options.registration ? { registration: {} } : {}),
  });
  const api = testResourceServer(w, {
    resource: API,
    scopesSupported: ["read", "write"],
    now: w.clock.now,
    ...(options.rsDpop === undefined ? {} : { dpop: options.rsDpop }),
  });
  const handle = async (request: Request) => {
    const metadata = api.handleMetadata(request);
    if (metadata !== null) return metadata;
    const scopes = request.method === "POST" ? ["read", "write"] : ["read"];
    const result = await api.verifyRequest(request, { scopes });
    if (!result.ok) return result.challenge.toResponse();
    return Response.json({
      subject: result.principal.subject,
      type: result.principal.tokenType,
      body: request.method === "POST" ? await request.text() : null,
    }, { headers: result.headers });
  };
  const fetch = routeFetch({ [ISSUER]: w.handle, [API]: handle });
  const agent = testUserAgent(fetch);
  return {
    w,
    api,
    fetch,
    agent,
    session: (extra = {}) =>
      new OAuthSession({
        resource: API,
        redirectUri: "https://app.test/cb",
        registration: {
          preregistered: { [ISSUER]: { client_id: "public-app" } },
        },
        userAgent: agent,
        fetch,
        now: w.clock.now,
        ...extra,
      }),
  };
}

function count(fetch: Setup["fetch"], suffix: string): number {
  return fetch.requests.filter((request) =>
    new URL(request.url).pathname.endsWith(suffix)
  ).length;
}

Deno.test("flow: a Bearer session discovers, authorizes, reuses and refreshes", async () => {
  const { w, fetch, agent, session: make } = await setup();
  const session = make();
  const first = await session.fetch(`${API}/files`);
  assertEquals(first.status, 200);
  assertEquals(await first.json(), {
    subject: "user-1",
    type: "Bearer",
    body: null,
  });
  assertEquals(agent.requests.length, 1);
  assertEquals(agent.requests[0].resource, API);
  assertEquals(agent.requests[0].scopes, ["read", "write"]);
  assertEquals(session.discovery?.issuer, ISSUER);
  assertEquals((await session.fetch(`${API}/files`)).status, 200);
  assertEquals(agent.requests.length, 1, "the token is reused");
  assertEquals(count(fetch, "/token"), 1);
  w.clock.advance(290_000);
  assertEquals((await session.fetch(`${API}/files`)).status, 200);
  assertEquals(count(fetch, "/token"), 2, "refreshed before expiry");
  assertEquals(agent.requests.length, 1);
});

Deno.test("flow: DPoP end to end, with nonces at both servers", async () => {
  const asNonce = await DpopNonceIssuer.create();
  const rsNonce = await DpopNonceIssuer.create();
  const { w, fetch, session: make } = await setup({
    asDpop: { nonce: asNonce },
    rsDpop: { required: true, nonce: rsNonce, replay: memoryReplayStore() },
  });
  const key = await DpopKey.generate({ now: w.clock.now });
  const session = make({ dpop: key });
  const response = await session.fetch(`${API}/files`, {
    method: "POST",
    body: "hello",
  });
  assertEquals(response.status, 200);
  assertEquals(await response.json(), {
    subject: "user-1",
    type: "DPoP",
    body: "hello",
  });
  const tokens = await session.tokens();
  assertEquals(tokens?.token_type, "DPoP");
  assertEquals(tokens?.dpop_jkt, key.jkt);
  const last = fetch.requests.filter((r) =>
    r.url.startsWith(API) && r.headers.has("dpop")
  ).at(-1)!;
  const proof = decode(last.headers.get("dpop")!).payload;
  assertEquals(proof.nonce, await rsNonce.current());
  assertEquals(last.headers.get("authorization")?.startsWith("DPoP "), true);
  // A later request uses the remembered nonce at once.
  const before = fetch.requests.length;
  assertEquals((await session.fetch(`${API}/files`)).status, 200);
  assertEquals(fetch.requests.length - before, 1);
  // Refresh goes through the AS nonce as well.
  w.clock.advance(290_000);
  assertEquals((await session.fetch(`${API}/files`)).status, 200);
  assertEquals((await session.tokens())?.token_type, "DPoP");
});

Deno.test("flow: a session with a different DPoP key drops the stored tokens", async () => {
  const { w, session: make } = await setup();
  const store = memoryOAuthStore();
  const first = make({
    dpop: await DpopKey.generate({ now: w.clock.now }),
    store,
  });
  assertEquals((await first.fetch(`${API}/files`)).status, 200);
  const second = make({
    dpop: await DpopKey.generate({ now: w.clock.now }),
    store,
  });
  await second.discover();
  assertEquals(await second.tokens(), undefined);
  assertEquals((await second.fetch(`${API}/files`)).status, 200);
});

Deno.test("flow: step-up on insufficient_scope, once per scope set", async () => {
  const { agent, session: make } = await setup();
  const session = make({ scopes: ["read"] });
  await session.authorize({ scopes: ["read"] });
  assertEquals(agent.requests.length, 1);
  const response = await session.fetch(`${API}/files`, {
    method: "POST",
    body: "x",
  });
  assertEquals(response.status, 200);
  assertEquals(agent.requests.length, 2);
  assertEquals(agent.requests[1].scopes, ["read", "write"]);
});

Deno.test("flow: the same step-up twice is an error", async () => {
  const w = await world({
    consent: (context) => ({
      grant: {
        subject: "u",
        scope: context.scope.filter((s) => s !== "write"),
      },
    }),
  });
  const api = testResourceServer(w, { resource: API, now: w.clock.now });
  const fetch = routeFetch({
    [ISSUER]: w.handle,
    [API]: async (request) => {
      const metadata = api.handleMetadata(request);
      if (metadata !== null) return metadata;
      const result = await api.verifyRequest(request, { scopes: ["write"] });
      return result.ok ? new Response("ok") : result.challenge.toResponse();
    },
  });
  const session = new OAuthSession({
    resource: API,
    redirectUri: "https://app.test/cb",
    registration: { preregistered: { [ISSUER]: { client_id: "public-app" } } },
    userAgent: testUserAgent(fetch),
    fetch,
    now: w.clock.now,
    scopes: ["read"],
    maxAttempts: 5,
  });
  await rejects(() => session.fetch(`${API}/files`), {
    kind: "insufficient_scope",
  });
});

Deno.test("flow: client credentials sessions need no user", async () => {
  const { w, fetch, agent, session: make } = await setup();
  const session = make({
    userAgent: undefined,
    registration: undefined,
    clientCredentials: {
      issuer: ISSUER,
      clientId: "web-app",
      clientSecret: SECRET,
    },
    scopes: ["read"],
  });
  const response = await session.fetch(`${API}/files`);
  assertEquals(response.status, 200);
  assertEquals((await response.json()).subject, "web-app");
  assertEquals(agent.requests.length, 0);
  w.clock.advance(290_000);
  assertEquals((await session.fetch(`${API}/files`)).status, 200);
  assertEquals(count(fetch, "/token"), 2);
  const wrongIssuer = make({
    userAgent: undefined,
    clientCredentials: {
      issuer: "https://elsewhere.test",
      clientId: "web-app",
      clientSecret: SECRET,
    },
  });
  await rejects(() => wrongIssuer.fetch(`${API}/files`), {
    kind: "registration",
  });
});

Deno.test("flow: dynamic registration, and no user agent means interaction_required", async () => {
  const { w, session: make } = await setup({ registration: true });
  const store = memoryOAuthStore();
  const session = make({
    store,
    registration: { dynamic: { client_name: "Tool", application_type: "web" } },
  });
  assertEquals((await session.fetch(`${API}/files`)).status, 200);
  const client = (await store.getClient(ISSUER))!;
  assertEquals(client.source, "dynamic");
  assert(
    (await w.store.get(`client:${client.client_id}`)) !== null,
    "the server kept the registration",
  );
  const lonely = make({ userAgent: undefined });
  await rejects(() => lonely.fetch(`${API}/files`), {
    kind: "interaction_required",
  });
});

Deno.test("flow: a revoked token is refreshed, a revoked family starts over", async () => {
  const { w, agent, session: make } = await setup({ rsDpop: false });
  const store = memoryOAuthStore();
  const session = make({ store });
  assertEquals((await session.fetch(`${API}/files`)).status, 200);
  const tokens = (await session.tokens())!;
  // A token the resource refuses (as after a key rotation).
  await store.setTokens(ISSUER, API, { ...tokens, access_token: "garbage" });
  assertEquals((await session.fetch(`${API}/files`)).status, 200);
  assertEquals(agent.requests.length, 1, "a refresh, not a new authorization");
  const current = (await session.tokens())!;
  const revoke = await w.handle(
    new Request(`${ISSUER}/revoke`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        token: current.refresh_token!,
        client_id: "public-app",
      }),
    }),
  );
  assertEquals(revoke.status, 200);
  await store.setTokens(ISSUER, API, { ...current, access_token: "garbage" });
  assertEquals((await session.fetch(`${API}/files`)).status, 200);
  assertEquals(
    agent.requests.length,
    2,
    "the family was gone, so the user authorized again",
  );
});

Deno.test("flow: a host that splits the redirect across requests", async () => {
  const { fetch, session: make } = await setup();
  const session = make({ userAgent: undefined });
  const pending = await session.beginAuthorization({ scopes: ["read"] });
  const kept = JSON.parse(JSON.stringify(pending));
  const callback = await testUserAgent(fetch).authorize({
    url: new URL(kept.url),
    redirectUri: kept.redirectUri,
    state: kept.state,
    issuer: kept.issuer,
    resource: API,
    scopes: ["read"],
    signal: new AbortController().signal,
  });
  const later = make({ userAgent: undefined });
  await rejects(
    () => later.completeAuthorization({ ...kept, state: "x" }, callback),
    {
      kind: "state_mismatch",
    },
  );
  const again = make({ userAgent: undefined });
  const pending2 = await again.beginAuthorization({ scopes: ["read"] });
  const callback2 = await testUserAgent(fetch).authorize({
    url: new URL(pending2.url),
    redirectUri: pending2.redirectUri,
    state: pending2.state,
    issuer: pending2.issuer,
    resource: API,
    scopes: ["read"],
    signal: new AbortController().signal,
  });
  const tokens = await again.completeAuthorization(pending2, callback2);
  assertEquals(tokens.token_type, "Bearer");
  assertEquals((await again.fetch(`${API}/files`)).status, 200);
});

Deno.test("flow: a transport of its own keeps up with a nonce rotated on every 200 through observe", async () => {
  // Each nonce the resource hands out replaces the one before, and only
  // the latest is accepted.
  let issued = 0;
  const nonce = {
    current: () => Promise.resolve(`nonce-${++issued}`),
    check: (value: string) => Promise.resolve(value === `nonce-${issued}`),
  };
  const { w, fetch, session: make } = await setup({
    rsDpop: { required: true, nonce, replay: memoryReplayStore() },
  });
  const url = `${API}/files`;
  const calls = () =>
    fetch.requests.filter((request) => request.url === url).length;

  /** What an MCP transport does: headers, send, observe or challenge. */
  async function send(session: OAuthSession, observe: boolean) {
    for (let attempt = 1;; attempt++) {
      const response = await fetch(url, {
        headers: await session.headers({ method: "GET", url }),
      });
      if (response.status !== 401 && response.status !== 403) {
        if (observe) session.observe({ url, headers: response.headers });
        return response;
      }
      assert(attempt < 5, "the transport gave up");
      const again = await session.challenge({
        status: response.status,
        headers: response.headers,
        method: "GET",
        url,
        attempt,
      });
      if (!again) return response;
    }
  }

  const session = make({ dpop: await DpopKey.generate({ now: w.clock.now }) });
  const first = await send(session, true);
  assertEquals(first.status, 200);
  assertEquals((await first.json()).type, "DPoP");
  assertEquals(first.headers.get("dpop-nonce"), `nonce-${issued}`);
  for (let i = 0; i < 3; i++) {
    const before = calls();
    const response = await send(session, true);
    assertEquals(response.status, 200);
    assertEquals(calls() - before, 1, "the rotated nonce is used at once");
    const sent = fetch.requests.at(-1)!;
    assertEquals(
      decode(sent.headers.get("dpop")!).payload.nonce,
      `nonce-${issued - 1}`,
    );
  }

  // Without observe, every request after a rotation costs a retry.
  const blind = make({ dpop: await DpopKey.generate({ now: w.clock.now }) });
  assertEquals((await send(blind, false)).status, 200);
  const before = calls();
  assertEquals((await send(blind, false)).status, 200);
  assertEquals(calls() - before, 2, "a stale nonce, then use_dpop_nonce");
});

Deno.test("flow: observe takes a usable DPoP-Nonce and ignores the rest", () => {
  const session = new OAuthSession({ resource: API });
  const headers = (nonce?: string) =>
    new Headers(nonce === undefined ? {} : { "dpop-nonce": nonce });
  assertEquals(session.observe({ url: API, headers: headers() }), undefined);
  assertEquals(
    session.observe({ url: API, headers: headers("bad nonce") }),
    undefined,
  );
  assertEquals(
    session.observe({ url: new URL(`${API}/x`), headers: headers("n-1") }),
    "n-1",
  );
});

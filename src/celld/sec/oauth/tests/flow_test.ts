// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

import { assert, assertEquals } from "@celld/core/assert";
import { decode } from "@celld/sec/jwt";
import {
  memoryOAuthStore,
  OAuthSession,
  type OAuthSessionOptions,
} from "@celld/sec/oauth/client";
import {
  DpopKey,
  DpopNonceIssuer,
  unsafeMemoryReplayStore,
} from "@celld/sec/oauth/dpop";
import type {
  ResourceDpopOptions,
  ResourceServer,
} from "@celld/sec/oauth/resource";
import type { AuthorizationServerOptions } from "@celld/sec/oauth/server";
import {
  routeFetch,
  testResourceServer,
  testUserAgent,
} from "@celld/sec/oauth/testing";
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

Deno.test("Daybreak sessions attribute stale refusals to the exact request", async () => {
  const { w, session: make } = await setup();
  const session = make();
  await session.authorize();
  const url = `${API}/files`;
  const old = await session.resourceHeaders({ method: "GET", url });
  w.clock.advance(290_000);
  const current = await session.resourceHeaders({ method: "GET", url });
  assert(
    old.authorization !== current.authorization,
    "refresh replaces the token",
  );
  assertEquals(
    await session.challenge({
      status: 401,
      headers: new Headers({
        "www-authenticate": 'Bearer error="invalid_token"',
      }),
      method: "GET",
      url,
      attempt: 2,
      authContext: old,
    }),
    true,
  );
  assertEquals(
    (await session.resourceHeaders({ method: "GET", url })).authorization,
    current.authorization,
  );
  assertEquals(
    await session.challenge({
      status: 401,
      headers: new Headers(),
      method: "GET",
      url,
      attempt: 2,
      authContext: { ...current },
    }),
    false,
  );
  assertEquals(
    session.observe({
      url: `${API}/other`,
      headers: new Headers({ "dpop-nonce": "foreign" }),
      authContext: current,
    }),
    undefined,
  );
});

Deno.test("Daybreak changed stored generation cannot release credentials or write refresh intent", async () => {
  const { fetch, session: make } = await setup();
  const store = memoryOAuthStore();
  const session = make({ store });
  const response = await session.resourceFetch(`${API}/files`);
  assertEquals(response.status, 200);
  await response.body?.cancel();
  const tokens = (await session.tokens())!;
  await store.setTokens(ISSUER, API, {
    ...tokens,
    access_token: "a-different-token-under-the-same-generation",
  });
  const before = fetch.requests.length;
  await rejects(() => session.resourceFetch(`${API}/files`), { kind: "token" });
  assertEquals(fetch.requests.length, before, "no credential-bearing request");
  assertEquals(
    (await store.getTokens(ISSUER, API))?.refresh_token,
    tokens.refresh_token,
    "invalid identity cannot write a refresh intent",
  );
  const signedOut = await session.signOut({ revoke: true });
  assertEquals(signedOut.revoked, false);
  assert(signedOut.error !== undefined, "invalid identity is reported");
  assertEquals(fetch.requests.length, before, "no invalid remote revocation");
  assertEquals(await store.getTokens(ISSUER, API), undefined);
});

Deno.test("Daybreak sign-out captures revocation intent before awaiting storage", async () => {
  const { fetch, session: make } = await setup();
  const store = memoryOAuthStore();
  const options = { revoke: false };
  let mutate = false;
  const session = make({
    store: {
      ...store,
      async getTokens(issuer, resource) {
        if (mutate) options.revoke = true;
        return await store.getTokens(issuer, resource);
      },
    },
  });
  const response = await session.resourceFetch(`${API}/files`);
  assertEquals(response.status, 200);
  await response.body?.cancel();
  const before = fetch.requests.length;
  mutate = true;
  assertEquals(await session.signOut(options), { revoked: false });
  assertEquals(fetch.requests.length, before, "revocation was never requested");
  assertEquals(await store.getTokens(ISSUER, API), undefined);
});

Deno.test("Daybreak 1000 simultaneous first uses perform one authorization", async () => {
  const { agent, session: make } = await setup();
  const session = make();
  const responses = await Promise.all(
    Array.from({ length: 1000 }, () => session.resourceFetch(`${API}/files`)),
  );
  assert(
    responses.every((response) => response.status === 200),
    "all callers authenticate",
  );
  assertEquals(agent.requests.length, 1);
  await Promise.all(responses.map((response) => response.body?.cancel()));
});

Deno.test("Daybreak cancelling one authorization waiter does not cancel another", async () => {
  const { agent, session: make } = await setup();
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const session = make({
    userAgent: {
      async authorize(request) {
        entered.resolve();
        await release.promise;
        return await agent.authorize(request);
      },
    },
  });
  const cancel = new AbortController();
  const first = session.authorize({ signal: cancel.signal }).then(
    () => false,
    () => true,
  );
  const second = session.authorize();
  await entered.promise;
  cancel.abort(new Error("one caller left"));
  assertEquals(await first, true);
  release.resolve();
  assertEquals((await second).token_type, "Bearer");
  assertEquals(agent.requests.length, 1);
});

Deno.test("Daybreak sign-out fences an in-flight authorization", async () => {
  const { agent, session: make } = await setup();
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const session = make({
    userAgent: {
      async authorize(request) {
        const callback = await agent.authorize(request);
        entered.resolve();
        await release.promise;
        return callback;
      },
    },
  });
  const pending = session.authorize().then(() => false, () => true);
  await entered.promise;
  await session.signOut();
  release.resolve();
  assertEquals(await pending, true);
  assertEquals(await session.tokens(), undefined);
});

Deno.test("Daybreak failed authorization never commits requested scopes", async () => {
  const { agent, session: make } = await setup();
  let fail = true;
  const session = make({
    userAgent: {
      authorize(request) {
        if (fail) throw new Error("consent failed");
        return agent.authorize(request);
      },
    },
  });
  assertEquals(
    await session.authorize({ scopes: ["write"] }).then(
      () => false,
      () => true,
    ),
    true,
  );
  fail = false;
  await session.authorize({ scopes: ["read"] });
  assertEquals(agent.requests[0].scopes, ["read"]);
});

Deno.test("Daybreak a challenge paused in storage cannot authorize after sign-out", async () => {
  const { agent, session: make } = await setup();
  const store = memoryOAuthStore();
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let pause = false;
  const session = make({
    store: {
      ...store,
      async getTokens(issuer, resource) {
        if (pause) {
          pause = false;
          entered.resolve();
          await release.promise;
        }
        return await store.getTokens(issuer, resource);
      },
    },
  });
  await session.authorize();
  const url = `${API}/files`;
  const context = await session.resourceHeaders({ method: "GET", url });
  pause = true;
  const challenge = session.challenge({
    status: 401,
    headers: new Headers({
      "www-authenticate": 'Bearer error="invalid_token"',
    }),
    method: "GET",
    url,
    attempt: 1,
    authContext: context,
  }).then(() => false, () => true);
  await entered.promise;
  await session.signOut();
  release.resolve();
  assertEquals(await challenge, true, "old challenge is cancelled");
  assertEquals(agent.requests.length, 1, "sign-out cannot trigger a new login");
  assertEquals(await session.tokens(), undefined);
});

Deno.test("Daybreak remote revocation cannot delete a subsequent login", async () => {
  const { fetch, session: make } = await setup();
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const session = make({
    fetch: async (input, init) => {
      const url = input instanceof Request ? input.url : String(input);
      if (new URL(url).pathname.endsWith("/revoke")) {
        entered.resolve();
        await release.promise;
      }
      return await fetch(input, init);
    },
  });
  await session.authorize();
  const logout = session.signOut({ revoke: true });
  await entered.promise;
  assertEquals(await session.tokens(), undefined, "local logout is immediate");
  const current = await session.authorize();
  release.resolve();
  assertEquals((await logout).revoked, true);
  assertEquals((await session.tokens())?.access_token, current.access_token);
});

Deno.test("Daybreak sign-out deletes local tokens even when its read fails", async () => {
  const { session: make } = await setup();
  const store = memoryOAuthStore();
  let fail = false;
  const session = make({
    store: {
      ...store,
      getTokens(issuer, resource) {
        if (fail) {
          fail = false;
          throw new Error("read unavailable");
        }
        return store.getTokens(issuer, resource);
      },
    },
  });
  await session.authorize();
  fail = true;
  assertEquals(await session.signOut().then(() => false, () => true), true);
  assertEquals(await store.getTokens(ISSUER, API), undefined);
});

Deno.test("Daybreak an ambiguous refresh never replays its credential after session restart", async () => {
  const { w, fetch, session: make } = await setup();
  const store = memoryOAuthStore();
  let loseResponse = false;
  let refreshes = 0;
  const transport: typeof fetch = Object.assign(
    async (input: string | URL | Request, init?: RequestInit) => {
      const request = new Request(input, init);
      const refresh = new URL(request.url).pathname.endsWith("/token") &&
        (await request.clone().text()).includes("grant_type=refresh_token");
      if (refresh) refreshes++;
      const answer = await fetch(request);
      if (refresh && loseResponse) {
        loseResponse = false;
        await answer.body?.cancel();
        throw new TypeError("the response was lost after the server committed");
      }
      return answer;
    },
    { requests: fetch.requests },
  );
  const first = make({ store, fetch: transport });
  await first.authorize();
  const old = await first.resourceHeaders({ method: "GET", url: API });
  w.clock.advance(250_000);
  loseResponse = true;
  assertEquals(
    (await first.resourceHeaders({ method: "GET", url: API })).authorization,
    old.authorization,
  );
  assertEquals(refreshes, 1);
  assertEquals((await store.getTokens(ISSUER, API))?.refresh_token, undefined);
  const restarted = make({ store, fetch: transport });
  await restarted.discover();
  assertEquals(
    (await restarted.resourceHeaders({ method: "GET", url: API }))
      .authorization,
    old.authorization,
  );
  assertEquals(refreshes, 1, "durable state must not permit retransmission");
  w.clock.advance(60_000);
  assertEquals(
    await restarted.resourceHeaders({ method: "GET", url: API }),
    {},
  );
  assertEquals(refreshes, 1);
});

Deno.test("Daybreak stored tokens require resource-bound provenance and locking", async () => {
  const { session: make } = await setup();
  const store = memoryOAuthStore();
  const session = make({ store });
  await session.discover();
  await store.setTokens(ISSUER, API, {
    access_token: "invented",
    token_type: "Bearer",
  });
  await rejects(() => session.resourceHeaders({ method: "GET", url: API }), {
    kind: "token",
  });
  let rejected = false;
  try {
    make({ store: { ...store, lock: undefined } });
  } catch {
    rejected = true;
  }
  assert(rejected, "unsafe unlocked storage is refused by default");
  make({
    store: { ...store, lock: undefined },
    unsafeAllowUnlockedStore: true,
  });
});

Deno.test("Daybreak session policy errors fail at construction", async () => {
  const { session: make } = await setup();
  for (
    const options of [
      { now: () => NaN },
      { registration: { dynamic: "false" } },
      {
        registration: {
          preregistered: { [ISSUER]: { client_id: "app", typo: true } },
        },
      },
      { resource: `${API}#fragment` },
      { scopes: "read" },
    ]
  ) {
    let refused = false;
    try {
      make(options as never);
    } catch {
      refused = true;
    }
    assert(refused, "invalid nested session policy");
  }
});

Deno.test("flow: a Bearer session discovers, authorizes, reuses and refreshes", async () => {
  const { w, fetch, agent, session: make } = await setup();
  const session = make();
  const first = await session.resourceFetch(`${API}/files`);
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
  assertEquals((await session.resourceFetch(`${API}/files`)).status, 200);
  assertEquals(agent.requests.length, 1, "the token is reused");
  assertEquals(count(fetch, "/token"), 1);
  w.clock.advance(290_000);
  assertEquals((await session.resourceFetch(`${API}/files`)).status, 200);
  assertEquals(count(fetch, "/token"), 2, "refreshed before expiry");
  assertEquals(agent.requests.length, 1);
});

Deno.test("flow: DPoP end to end, with nonces at both servers", async () => {
  const asNonce = await DpopNonceIssuer.create();
  const rsNonce = await DpopNonceIssuer.create();
  const { w, fetch, session: make } = await setup({
    asDpop: { nonce: asNonce },
    rsDpop: {
      required: true,
      nonce: rsNonce,
      replay: unsafeMemoryReplayStore(),
    },
  });
  const key = await DpopKey.generate({ now: w.clock.now });
  const session = make({ dpop: key });
  const response = await session.resourceFetch(`${API}/files`, {
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
  assertEquals((await session.resourceFetch(`${API}/files`)).status, 200);
  assertEquals(fetch.requests.length - before, 1);
  // Refresh goes through the AS nonce as well.
  w.clock.advance(290_000);
  assertEquals((await session.resourceFetch(`${API}/files`)).status, 200);
  assertEquals((await session.tokens())?.token_type, "DPoP");
});

Deno.test("flow: a session with a different DPoP key drops the stored tokens", async () => {
  const { w, session: make } = await setup();
  const store = memoryOAuthStore();
  const first = make({
    dpop: await DpopKey.generate({ now: w.clock.now }),
    store,
  });
  assertEquals((await first.resourceFetch(`${API}/files`)).status, 200);
  const second = make({
    dpop: await DpopKey.generate({ now: w.clock.now }),
    store,
  });
  await second.discover();
  assertEquals(await second.tokens(), undefined);
  assertEquals((await second.resourceFetch(`${API}/files`)).status, 200);
});

Deno.test("flow: step-up on insufficient_scope, once per scope set", async () => {
  const { agent, session: make } = await setup();
  const session = make({ scopes: ["read"] });
  await session.authorize({ scopes: ["read"] });
  assertEquals(agent.requests.length, 1);
  const response = await session.resourceFetch(`${API}/files`, {
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
  await rejects(() => session.resourceFetch(`${API}/files`), {
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
  const response = await session.resourceFetch(`${API}/files`);
  assertEquals(response.status, 200);
  assertEquals((await response.json()).subject, "web-app");
  assertEquals(agent.requests.length, 0);
  w.clock.advance(290_000);
  assertEquals((await session.resourceFetch(`${API}/files`)).status, 200);
  assertEquals(count(fetch, "/token"), 2);
  const wrongIssuer = make({
    userAgent: undefined,
    clientCredentials: {
      issuer: "https://elsewhere.test",
      clientId: "web-app",
      clientSecret: SECRET,
    },
  });
  await rejects(() => wrongIssuer.resourceFetch(`${API}/files`), {
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
  assertEquals((await session.resourceFetch(`${API}/files`)).status, 200);
  const client = (await store.getClient(ISSUER))!;
  assertEquals(client.source, "dynamic");
  assert(
    (await w.store.get(`client:${client.client_id}`)) !== null,
    "the server kept the registration",
  );
  const lonely = make({ userAgent: undefined });
  await rejects(() => lonely.resourceFetch(`${API}/files`), {
    kind: "interaction_required",
  });
});

Deno.test("flow: a revoked token is refreshed, a revoked family starts over", async () => {
  const { w, agent, fetch, session: make } = await setup({ rsDpop: false });
  const store = memoryOAuthStore();
  const revoked = new Set<string>();
  const transport: typeof fetch = Object.assign(
    async (input: string | URL | Request, init?: RequestInit) => {
      const request = new Request(input, init);
      if (
        new URL(request.url).origin === API &&
        revoked.has(request.headers.get("authorization") ?? "")
      ) {
        return new Response(null, {
          status: 401,
          headers: {
            "www-authenticate": 'Bearer error="invalid_token"',
            "cache-control": "private, no-store",
          },
        });
      }
      return await fetch(request);
    },
    fetch,
  );
  const session = make({ store, fetch: transport });
  assertEquals((await session.resourceFetch(`${API}/files`)).status, 200);
  const tokens = (await session.tokens())!;
  // Revoke the actual credential at the resource, without corrupting its
  // authenticated stored grant identity to simulate a server refusal.
  revoked.add(`Bearer ${tokens.access_token}`);
  assertEquals((await session.resourceFetch(`${API}/files`)).status, 200);
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
  revoked.add(`Bearer ${current.access_token}`);
  assertEquals((await session.resourceFetch(`${API}/files`)).status, 200);
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
      kind: "authorization",
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
  assertEquals((await again.resourceFetch(`${API}/files`)).status, 200);
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
    rsDpop: { required: true, nonce, replay: unsafeMemoryReplayStore() },
  });
  const url = `${API}/files`;
  const calls = () =>
    fetch.requests.filter((request) => request.url === url).length;

  /** What an MCP transport does: headers, send, observe or challenge. */
  async function send(session: OAuthSession, observe: boolean) {
    for (let attempt = 1;; attempt++) {
      const authContext = await session.resourceHeaders({ method: "GET", url });
      const response = await fetch(url, {
        headers: authContext,
      });
      if (response.status !== 401 && response.status !== 403) {
        if (observe) {
          session.observe({ url, headers: response.headers, authContext });
        }
        return response;
      }
      assert(attempt < 5, "the transport gave up");
      const again = await session.challenge({
        status: response.status,
        headers: response.headers,
        method: "GET",
        url,
        attempt,
        authContext,
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

Deno.test("flow: observe takes a request-bound usable DPoP-Nonce and ignores the rest", async () => {
  const session = new OAuthSession({ resource: API });
  const headers = (nonce?: string) =>
    new Headers(nonce === undefined ? {} : { "dpop-nonce": nonce });
  const authContext = await session.resourceHeaders({
    method: "GET",
    url: `${API}/x`,
  });
  assertEquals(
    session.observe({ url: API, headers: headers(), authContext }),
    undefined,
  );
  assertEquals(
    session.observe({
      url: `${API}/x`,
      headers: headers("bad nonce"),
      authContext,
    }),
    undefined,
  );
  assertEquals(
    session.observe({
      url: new URL(`${API}/x`),
      headers: headers("n-1"),
      authContext,
    }),
    "n-1",
  );
});

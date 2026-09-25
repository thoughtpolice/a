// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

import { assert, assertEquals } from "@celld/assert";
import { decode } from "@celld/jwt";
import {
  type AuthorizationServerMetadata,
  JWT_BEARER_ASSERTION,
} from "@celld/oauth";
import {
  applicationTypeFor,
  applyClientAuthentication,
  checkClientIdUrl,
  clientMetadataDocument,
  discoverAuthorizationServer,
  discoverProtectedResource,
  memoryOAuthStore,
  OAuthClient,
  type OAuthClientOptions,
  registerClient,
  resolveClient,
} from "@celld/oauth/client";
import { DpopKey, DpopNonceIssuer } from "@celld/oauth/dpop";
import { routeFetch, testUserAgent } from "@celld/oauth/testing";
import {
  API,
  ISSUER,
  rejects,
  RS_SECRET,
  SECRET,
  type World,
  world,
} from "./fixture.ts";

function recording(
  answers: Readonly<Record<string, () => Response>>,
):
  & ((input: string | URL | Request, init?: RequestInit) => Promise<Response>)
  & {
    urls: string[];
  } {
  const urls: string[] = [];
  const fetch = (input: string | URL | Request) => {
    const url = input instanceof Request ? input.url : String(input);
    urls.push(url);
    const answer = answers[url];
    return Promise.resolve(
      answer === undefined ? new Response("no", { status: 404 }) : answer(),
    );
  };
  return Object.assign(fetch, { urls });
}

Deno.test("AS discovery: RFC 8414 first, then OpenID, never a document for another issuer", async () => {
  const issuer = "https://as.test/tenant";
  const fetch = recording({
    "https://as.test/.well-known/oauth-authorization-server/tenant": () =>
      Response.json({ issuer: "https://as.test/other" }),
    "https://as.test/.well-known/openid-configuration/tenant": () =>
      Response.json({ issuer, token_endpoint: "http://as.test/token" }),
    "https://as.test/tenant/.well-known/openid-configuration": () =>
      Response.json({ issuer, token_endpoint: "https://as.test/tenant/token" }),
  });
  const metadata = await discoverAuthorizationServer(issuer, { fetch });
  assertEquals(metadata.token_endpoint, "https://as.test/tenant/token");
  assertEquals(fetch.urls, [
    "https://as.test/.well-known/oauth-authorization-server/tenant",
    "https://as.test/.well-known/openid-configuration/tenant",
    "https://as.test/tenant/.well-known/openid-configuration",
  ]);
  await rejects(
    () => discoverAuthorizationServer(issuer, { fetch, oidc: false }),
    { kind: "discovery" },
  );
  await rejects(
    () => discoverAuthorizationServer("http://as.test", { fetch }),
    { kind: "discovery" },
  );
  await rejects(
    () =>
      discoverAuthorizationServer("https://down.test", {
        fetch: () => Promise.resolve(new Response("", { status: 503 })),
      }),
    { kind: "network", status: 503 },
  );
  await rejects(
    () =>
      discoverAuthorizationServer("https://down.test", {
        fetch: () => Promise.reject(new TypeError("refused")),
      }),
    { kind: "network" },
  );
  await rejects(
    () =>
      discoverAuthorizationServer("https://bad.test", {
        fetch: () =>
          Promise.resolve(
            Response.json({
              issuer: "https://bad.test",
              scopes_supported: "read",
            }),
          ),
      }),
    { kind: "discovery" },
  );
});

Deno.test("PRM discovery: the challenge's URL, else well-known, and resource must match", async () => {
  const prm = (resource: string, servers: unknown = [ISSUER]) => () =>
    Response.json({ resource, authorization_servers: servers });
  const fetch = recording({
    "https://api.test/.well-known/oauth-protected-resource/v1": prm(
      "https://api.test/v1",
    ),
    "https://api.test/meta": prm("https://api.test"),
    "https://evil.test/meta": prm("https://evil.test"),
    "https://api.test/.well-known/oauth-protected-resource": prm(
      "https://api.test",
      [],
    ),
  });
  const found = await discoverProtectedResource("https://api.test/v1", {
    fetch,
  });
  assertEquals(found.resource, "https://api.test/v1");
  assertEquals(found.authorizationServers, [ISSUER]);
  const viaChallenge = await discoverProtectedResource(
    "https://api.test/v1/files",
    {
      fetch,
      resourceMetadataUrl: "https://api.test/meta",
    },
  );
  assertEquals(viaChallenge.resource, "https://api.test");
  await rejects(
    () =>
      discoverProtectedResource("https://api.test/v1/files", {
        fetch,
        resourceMetadataUrl: "https://evil.test/meta",
      }),
    { kind: "discovery" },
  );
  await rejects(
    () =>
      discoverProtectedResource("https://api.test/v1/files", {
        fetch,
        resourceMetadataUrl: "http://api.test/meta",
      }),
    { kind: "discovery" },
  );
  await rejects(
    () =>
      discoverProtectedResource("https://api.test/v1/files", {
        fetch,
        exact: true,
      }),
    { kind: "discovery" },
  );
  await rejects(
    () => discoverProtectedResource("https://api.test/v2", { fetch }),
    {
      kind: "discovery",
    },
  );
});

function client(w: World, options: Partial<OAuthClientOptions> = {}) {
  const fetch = routeFetch({ [ISSUER]: w.handle });
  return {
    fetch,
    client: new OAuthClient({
      issuer: ISSUER,
      client: { method: "none", clientId: "public-app" },
      redirectUri: "https://app.test/cb",
      fetch,
      now: w.clock.now,
      ...options,
    }),
  };
}

Deno.test("OAuthClient: code flow with PAR, PKCE, resource and iss", async () => {
  const w = await world();
  const { client: c, fetch } = client(w);
  const pending = await c.authorizationUrl({ scope: ["read"], resource: API });
  const url = new URL(pending.url);
  // The server has a PAR endpoint, so the request was pushed.
  assertEquals([...url.searchParams.keys()].sort(), [
    "client_id",
    "request_uri",
  ]);
  assert(pending.issRequired, "the server promises iss");
  assertEquals(pending.verifier.length, 43);
  const pushed = fetch.requests.find((r) => r.url.endsWith("/par"))!;
  const pushedParams = new URLSearchParams(await pushed.text());
  assertEquals(pushedParams.get("code_challenge_method"), "S256");
  assertEquals(pushedParams.get("resource"), API);
  assertEquals(pushedParams.get("state"), pending.state);
  const callback = await testUserAgent(fetch).authorize({
    url,
    redirectUri: pending.redirectUri,
    state: pending.state,
    issuer: ISSUER,
    resource: API,
    scopes: ["read"],
    signal: new AbortController().signal,
  });
  const tokens = await c.completeAuthorization(pending, callback);
  assertEquals(tokens.token_type, "Bearer");
  assertEquals(tokens.scope, "read");
  assertEquals(tokens.requested_scope, "read");
  assertEquals(tokens.expires_at, w.clock.now() + 300_000);
  const refreshed = await c.refresh(tokens.refresh_token!);
  assert(refreshed.refresh_token !== tokens.refresh_token, "rotated");
});

Deno.test("OAuthClient: without PAR the parameters are in the URL", async () => {
  const w = await world();
  const { client: c } = client(w, { par: "never" });
  const pending = await c.authorizationUrl({
    scope: ["read", "write"],
    resource: [API, "https://other.test"],
  });
  const params = new URL(pending.url).searchParams;
  assertEquals(params.get("response_type"), "code");
  assertEquals(params.get("code_challenge_method"), "S256");
  assertEquals(params.get("scope"), "read write");
  assertEquals(params.getAll("resource"), [API, "https://other.test"]);
  assertEquals(params.get("dpop_jkt"), null);
  const strict = await world({ requirePar: true });
  await rejects(
    () => client(strict, { par: "never" }).client.authorizationUrl(),
    {
      kind: "unsupported",
    },
  );
});

Deno.test("OAuthClient: the authorization response is checked before the code is used", async () => {
  const w = await world();
  const { client: c } = client(w, { par: "never" });
  const pending = await c.authorizationUrl({ resource: API });
  const back = (params: Record<string, string>) => {
    const url = new URL(pending.redirectUri);
    for (const [name, value] of Object.entries(params)) {
      url.searchParams.set(name, value);
    }
    return url;
  };
  await rejects(
    () =>
      c.completeAuthorization(
        pending,
        back({ code: "c", state: pending.state, iss: "https://evil.test" }),
      ),
    { kind: "issuer_mismatch" },
  );
  await rejects(
    () =>
      c.completeAuthorization(
        pending,
        back({ code: "c", state: pending.state }),
      ),
    { kind: "issuer_mismatch" },
  );
  await rejects(
    () =>
      c.completeAuthorization(
        pending,
        back({ code: "c", state: "other", iss: ISSUER }),
      ),
    { kind: "state_mismatch" },
  );
  await rejects(
    () =>
      c.completeAuthorization(
        pending,
        back({
          error: "access_denied",
          error_description: "no",
          state: pending.state,
          iss: ISSUER,
        }),
      ),
    { kind: "authorization", error: "access_denied", description: "no" },
  );
  await rejects(
    () =>
      c.completeAuthorization(
        pending,
        back({ state: pending.state, iss: ISSUER }),
      ),
    { kind: "authorization" },
  );
  await rejects(
    () =>
      c.completeAuthorization(
        pending,
        back({ code: "made-up", state: pending.state, iss: ISSUER }),
      ),
    { kind: "token", error: "invalid_grant", status: 400 },
  );
});

Deno.test("OAuthClient: servers without PKCE S256 are refused", async () => {
  const metadata: AuthorizationServerMetadata = {
    issuer: ISSUER,
    authorization_endpoint: `${ISSUER}/authorize`,
    token_endpoint: `${ISSUER}/token`,
    code_challenge_methods_supported: ["plain"],
  };
  const c = new OAuthClient({
    issuer: ISSUER,
    metadata,
    client: { method: "none", clientId: "x" },
    redirectUri: "https://app.test/cb",
  });
  await rejects(() => c.authorizationUrl(), { kind: "unsupported" });
  const assumed = new OAuthClient({
    issuer: ISSUER,
    metadata,
    client: { method: "none", clientId: "x" },
    redirectUri: "https://app.test/cb",
    assumePkce: true,
  });
  const pending = await assumed.authorizationUrl();
  assertEquals(
    new URL(pending.url).searchParams.get("code_challenge_method"),
    "S256",
  );
  let threw = false;
  try {
    new OAuthClient({
      issuer: ISSUER,
      metadata: { issuer: "https://x.test" },
      client: { method: "none", clientId: "x" },
    });
  } catch {
    threw = true;
  }
  assert(threw, "metadata for another issuer is refused");
});

Deno.test("OAuthClient: DPoP binds codes and tokens, and retries on a nonce", async () => {
  const nonce = await DpopNonceIssuer.create();
  const w = await world({ dpop: { nonce } });
  const key = await DpopKey.generate({ now: w.clock.now });
  const { client: c, fetch } = client(w, { dpop: key });
  const pending = await c.authorizationUrl({ resource: API });
  assertEquals(pending.dpopJkt, key.jkt);
  const pushes = fetch.requests.filter((r) => r.url.endsWith("/par"));
  assertEquals(pushes.length, 2, "the first push got use_dpop_nonce");
  assertEquals(
    decode(pushes[1].headers.get("dpop")!).payload.nonce,
    await nonce.current(),
  );
  const callback = await testUserAgent(fetch).authorize({
    url: new URL(pending.url),
    redirectUri: pending.redirectUri,
    state: pending.state,
    issuer: ISSUER,
    resource: API,
    scopes: [],
    signal: new AbortController().signal,
  });
  const tokens = await c.completeAuthorization(pending, callback);
  assertEquals(tokens.token_type, "DPoP");
  assertEquals(tokens.dpop_jkt, key.jkt);
  const tokenRequests = fetch.requests.filter((r) => r.url.endsWith("/token"));
  assertEquals(tokenRequests.length, 1, "the nonce from PAR was reused");
  const refreshed = await c.refresh(tokens.refresh_token!);
  assertEquals(refreshed.token_type, "DPoP");
  // Another key cannot redeem a code bound to this one.
  const other = new OAuthClient({
    issuer: ISSUER,
    client: { method: "none", clientId: "public-app" },
    redirectUri: "https://app.test/cb",
    dpop: await DpopKey.generate(),
    fetch,
    now: w.clock.now,
  });
  await rejects(() => other.completeAuthorization(pending, callback), {
    kind: "dpop",
  });
});

Deno.test("OAuthClient: a Bearer answer to a DPoP request is refused unless allowed", async () => {
  const w = await world({ dpop: false });
  const key = await DpopKey.generate();
  const make = (allowBearerFallback: boolean) =>
    new OAuthClient({
      issuer: ISSUER,
      client: {
        method: "client_secret_basic",
        clientId: "web-app",
        clientSecret: SECRET,
      },
      dpop: key,
      allowBearerFallback,
      fetch: routeFetch({ [ISSUER]: w.handle }),
      now: w.clock.now,
    });
  await rejects(() => make(false).clientCredentials({ resource: API }), {
    kind: "dpop",
  });
  assertEquals(
    (await make(true).clientCredentials({ resource: API })).token_type,
    "Bearer",
  );
});

Deno.test("OAuthClient: client credentials with each authentication method", async () => {
  const w = await world();
  const fetch = routeFetch({ [ISSUER]: w.handle });
  const basic = new OAuthClient({
    issuer: ISSUER,
    client: {
      method: "client_secret_basic",
      clientId: "web-app",
      clientSecret: SECRET,
    },
    fetch,
    now: w.clock.now,
  });
  const tokens = await basic.clientCredentials({
    scope: ["read"],
    resource: API,
  });
  assertEquals(tokens.requested_scope, "read");
  assertEquals(tokens.refresh_token, undefined);
  const postClient = new OAuthClient({
    issuer: ISSUER,
    client: {
      method: "client_secret_post",
      clientId: "post-app",
      clientSecret: SECRET,
    },
    fetch,
    now: w.clock.now,
  });
  assertEquals(
    (await postClient.clientCredentials({ resource: API })).token_type,
    "Bearer",
  );
  const jwt = new OAuthClient({
    issuer: ISSUER,
    client: {
      method: "private_key_jwt",
      clientId: "jwt-app",
      privateKey: w.clientKey.privateKey,
      alg: "ES256",
      kid: "jwt-app-1",
    },
    fetch,
    now: w.clock.now,
  });
  await jwt.clientCredentials({ resource: API });
  await jwt.clientCredentials({ resource: API });
  const sent = new URLSearchParams(await fetch.requests.at(-1)!.text());
  assertEquals(sent.get("client_assertion_type"), JWT_BEARER_ASSERTION);
  const assertion = decode(sent.get("client_assertion")!);
  assertEquals(assertion.payload.aud, ISSUER);
  assertEquals(assertion.payload.iss, "jwt-app");
  assertEquals(assertion.header.kid, "jwt-app-1");
  const wrong = new OAuthClient({
    issuer: ISSUER,
    client: {
      method: "client_secret_basic",
      clientId: "web-app",
      clientSecret: "nope",
    },
    fetch,
    now: w.clock.now,
  });
  await rejects(() => wrong.clientCredentials({ resource: API }), {
    kind: "token",
    error: "invalid_client",
    status: 401,
  });
  await rejects(
    () =>
      new OAuthClient({
        issuer: ISSUER,
        client: { method: "none", clientId: "public-app" },
        fetch,
      })
        .clientCredentials(),
    { kind: "registration" },
  );
});

Deno.test("client authentication: what each method sends", async () => {
  const now = () => 1_800_000_000_000;
  const endpoint = `${ISSUER}/token`;
  assertEquals(
    await applyClientAuthentication(
      { method: "none", clientId: "c" },
      ISSUER,
      endpoint,
      now,
    ),
    { headers: {}, params: { client_id: "c" } },
  );
  assertEquals(
    (await applyClientAuthentication(
      { method: "client_secret_post", clientId: "c", clientSecret: "s" },
      ISSUER,
      endpoint,
      now,
    )).params,
    { client_id: "c", client_secret: "s" },
  );
  const w = await world();
  const endpointAud = await applyClientAuthentication(
    {
      method: "private_key_jwt",
      clientId: "jwt-app",
      privateKey: w.clientKey.privateKey,
      alg: "ES256",
      audience: "endpoint",
    },
    ISSUER,
    endpoint,
    now,
  );
  const claims = decode(endpointAud.params.client_assertion).payload;
  assertEquals(claims.aud, endpoint);
  assertEquals(claims.exp, 1_800_000_060);
});

Deno.test("OAuthClient: device authorization and polling", async () => {
  const w = await world();
  const fetch = routeFetch({ [ISSUER]: w.handle });
  const c = new OAuthClient({
    issuer: ISSUER,
    client: {
      method: "client_secret_basic",
      clientId: "web-app",
      clientSecret: SECRET,
    },
    fetch,
    now: w.clock.now,
  });
  const device = await c.deviceAuthorization({
    scope: ["read"],
    resource: API,
  });
  assertEquals(device.interval, 5);
  const waits: number[] = [];
  let polls = 0;
  const tokens = await c.pollDeviceToken(device, {
    sleep: async (ms) => {
      waits.push(ms);
      polls++;
      // The second poll comes too soon; before the third the user approves.
      w.clock.advance(polls === 2 ? 0 : ms);
      if (polls === 3) {
        await w.server.decideDevice(device.user_code, {
          grant: { subject: "tv" },
        });
      }
    },
  });
  assertEquals(tokens.token_type, "Bearer");
  assertEquals(waits, [5000, 5000, 10000]);
  const denied = await c.deviceAuthorization({ resource: API });
  await w.server.decideDevice(denied.user_code, { deny: {} });
  await rejects(
    () =>
      c.pollDeviceToken(denied, {
        sleep: () => Promise.resolve(w.clock.advance(5000)),
      }),
    { kind: "authorization", error: "access_denied" },
  );
  const expired = await c.deviceAuthorization({ resource: API });
  await rejects(
    () =>
      c.pollDeviceToken(expired, {
        sleep: () => Promise.resolve(w.clock.advance(700_000)),
      }),
    { kind: "authorization", error: "expired_token" },
  );
});

Deno.test("OAuthClient: token exchange, revocation, introspection", async () => {
  const w = await world({
    tokenExchange: async (context) => {
      const claims = await context.verifyAccessToken(context.subjectToken);
      return claims === null ? null : { subject: claims.sub as string };
    },
  });
  const fetch = routeFetch({ [ISSUER]: w.handle });
  const web = new OAuthClient({
    issuer: ISSUER,
    client: {
      method: "client_secret_basic",
      clientId: "web-app",
      clientSecret: SECRET,
    },
    fetch,
    now: w.clock.now,
  });
  const rs = new OAuthClient({
    issuer: ISSUER,
    client: {
      method: "client_secret_basic",
      clientId: "api",
      clientSecret: RS_SECRET,
    },
    fetch,
    now: w.clock.now,
  });
  const subject = await web.clientCredentials({ resource: API });
  const exchanged = await web.tokenExchange({
    subjectToken: subject.access_token,
    subjectTokenType: "urn:ietf:params:oauth:token-type:access_token",
    resource: "https://other.test",
  });
  assertEquals(
    exchanged.issued_token_type,
    "urn:ietf:params:oauth:token-type:access_token",
  );
  const active = await rs.introspect(exchanged.access_token, {
    hint: "access_token",
  });
  assertEquals(active.active, true);
  assertEquals(active.aud, "https://other.test");
  await web.revoke(exchanged.access_token);
  assertEquals((await rs.introspect(exchanged.access_token)).active, false);
  await rejects(
    () =>
      web.tokenExchange({
        subjectToken: "nope",
        subjectTokenType: "urn:ietf:params:oauth:token-type:access_token",
      }),
    { kind: "token", error: "invalid_grant" },
  );
});

Deno.test("registration: DCR requests, CIMD documents, and the resolution order", async () => {
  let sent: Record<string, unknown> = {};
  let authorization: string | null = null;
  const fetch = (_input: string | URL | Request, init?: RequestInit) => {
    sent = JSON.parse(String(init?.body));
    authorization = new Headers(init?.headers).get("authorization");
    return Promise.resolve(
      Response.json({ ...sent, client_id: "dyn-1", client_secret: "shh" }, {
        status: 201,
      }),
    );
  };
  const registered = await registerClient(`${ISSUER}/register`, {
    client_name: "Tool",
    redirect_uris: ["http://127.0.0.1:9000/cb"],
  }, { fetch, initialAccessToken: "iat" });
  assertEquals(sent.application_type, "native");
  assertEquals(sent.token_endpoint_auth_method, "none");
  assertEquals(sent.grant_types, ["authorization_code", "refresh_token"]);
  assertEquals(authorization, "Bearer iat");
  assertEquals(registered.client_id, "dyn-1");
  assertEquals(registered.client_secret, "shh");
  assertEquals(applicationTypeFor(["https://web.test/cb"]), "web");
  assertEquals(
    applicationTypeFor(["com.example:/cb", "http://[::1]/cb"]),
    "native",
  );
  await rejects(
    () =>
      registerClient(`${ISSUER}/register`, {}, {
        fetch: () =>
          Promise.resolve(
            Response.json({ error: "invalid_redirect_uri" }, { status: 400 }),
          ),
      }),
    { kind: "registration", error: "invalid_redirect_uri" },
  );

  const document = clientMetadataDocument({
    client_id: "https://tool.test/client.json",
    client_name: "Tool",
    redirect_uris: ["http://127.0.0.1/cb"],
  });
  assertEquals(document.token_endpoint_auth_method, "none");
  for (
    const bad of [
      "http://tool.test/c.json",
      "https://tool.test/",
      "https://tool.test/a#b",
      "https://u@tool.test/c",
      "https://tool.test/a/../c",
    ]
  ) {
    let threw = false;
    try {
      checkClientIdUrl(bad);
    } catch {
      threw = true;
    }
    assert(threw, bad);
  }

  const store = memoryOAuthStore();
  const metadata: AuthorizationServerMetadata = {
    issuer: ISSUER,
    registration_endpoint: `${ISSUER}/register`,
    client_id_metadata_document_supported: true,
  };
  const context = {
    metadata,
    redirectUris: ["http://127.0.0.1/cb"],
    store,
    fetch,
  };
  assertEquals(
    (await resolveClient(
      { preregistered: { [ISSUER]: { client_id: "pre" } } },
      context,
    )).source,
    "preregistered",
  );
  assertEquals(
    (await resolveClient({
      metadataDocument: "https://tool.test/client.json",
      dynamic: {},
    }, context))
      .client_id,
    "https://tool.test/client.json",
  );
  const dynamic = await resolveClient(
    { dynamic: { client_name: "Tool" } },
    context,
  );
  assertEquals(dynamic.source, "dynamic");
  assertEquals((await store.getClient(ISSUER))?.client_id, "dyn-1");
  assertEquals(
    (await resolveClient({ dynamic: { client_name: "Tool" } }, context))
      .client_id,
    "dyn-1",
  );
  await rejects(
    () => resolveClient({}, { ...context, store: memoryOAuthStore() }),
    { kind: "registration" },
  );
});

// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * Regressions for the wave-4 sweep (WP-13) against `@celld/sec/oauth`: token
 * endpoint and introspection egress, DPoP freshness, open registration,
 * ownership keys, secrets on public surfaces and live configuration. Each
 * is named by its `DB-SWP` identifier and failed on the code before it.
 *
 * @module
 */

import { assert, assertEquals } from "@celld/core/assert";
import type { Jwk } from "@celld/sec/jwt";
import type { AuthorizationServerMetadata } from "@celld/sec/oauth";
import {
  OAuthClient,
  OAuthSession,
  type OAuthSessionOptions,
} from "@celld/sec/oauth/client";
import {
  DpopKey,
  DpopNonceIssuer,
  type DpopVerifyOptions,
  unsafeMemoryReplayStore,
  verifyDpopProof,
} from "@celld/sec/oauth/dpop";
import {
  introspectionVerifier,
  type IntrospectionVerifierOptions,
  jwtAccessTokenVerifier,
  type JwtAccessTokenVerifierOptions,
  ResourceServer,
  type ResourceServerOptions,
} from "@celld/sec/oauth/resource";
import { oauthSchemes } from "@celld/sec/oauth/router";
import {
  AuthorizationServer,
  generateSigningKey,
  issueAccessToken,
  publicJwks,
  signingKeyFromJwk,
  unsafeMemoryRecordStore,
} from "@celld/sec/oauth/server";
import { manualClock, routeFetch } from "@celld/sec/oauth/testing";
import { router } from "@celld/web/router";
import {
  API,
  ISSUER,
  oauthError,
  OTHER_API,
  post,
  rejects,
  SECRET,
  WEB_AUTH,
  world,
} from "./fixture.ts";

const clock = manualClock(Date.UTC(2026, 8, 25, 12));
const key = await generateSigningKey("ES256", "k1");

// deno-lint-ignore no-explicit-any
const loose = (value: unknown): any => value;

type Handler = (request: Request) => Promise<Response> | Response;

/**
 * A fetch over `routes` that behaves as the platform's does about
 * redirects: `follow` (the default) re-sends the request to `Location`,
 * `error` throws, `manual` hands the 3xx back. Every URL reached is kept.
 */
function platformFetch(routes: Readonly<Record<string, Handler>>) {
  const reached: string[] = [];
  const fetch = async (
    input: string | URL | Request,
    init: RequestInit = {},
  ): Promise<Response> => {
    const request = new Request(input, init);
    reached.push(request.url);
    const handler = routes[new URL(request.url).origin];
    if (handler === undefined) throw new TypeError(`no route: ${request.url}`);
    const response = await handler(request);
    const location = response.headers.get("location");
    if (response.status >= 300 && response.status < 400 && location !== null) {
      const mode = init.redirect ?? "follow";
      if (mode === "error") {
        throw new TypeError("redirect with redirect: error");
      }
      if (mode === "follow") {
        return await fetch(new URL(location, request.url).href, init);
      }
    }
    return response;
  };
  return Object.assign(fetch, { reached });
}

const tokenAnswer = () =>
  Response.json({ access_token: "stolen", token_type: "Bearer" });

// ----- DB-SWP-F16-13.O1: token endpoint requests (known item) -----

Deno.test("DB-SWP-F16-13.O1: token endpoint requests never follow a redirect", async () => {
  const fetch = platformFetch({
    [ISSUER]: () =>
      new Response(null, {
        status: 307,
        headers: { location: "https://evil.test/steal" },
      }),
    "https://evil.test": tokenAnswer,
  });
  const metadata: AuthorizationServerMetadata = {
    issuer: ISSUER,
    token_endpoint: `${ISSUER}/token`,
  };
  const client = new OAuthClient({
    issuer: ISSUER,
    metadata,
    client: {
      method: "client_secret_post",
      clientId: "post-app",
      clientSecret: SECRET,
    },
    fetch,
  });
  await rejects(() => client.clientCredentials({ resource: API }), {
    name: "OAuthError",
  });
  await rejects(
    () =>
      client.unsafeRefresh("a-refresh-token", {
        issuer: client.issuer,
        clientId: client.clientId,
        resource: API,
        scope: [],
      }),
    {
      name: "OAuthError",
    },
  );
  assertEquals(
    fetch.reached.filter((url) => url.startsWith("https://evil.test")),
    [],
    "no credential reached the redirect target",
  );
});

Deno.test("DB-SWP-F16-13.O1: token endpoints follow the shared transport rule", async () => {
  const client = (token_endpoint: string, dev = false) =>
    new OAuthClient({
      issuer: ISSUER,
      metadata: { issuer: ISSUER, token_endpoint },
      client: {
        method: "client_secret_post",
        clientId: "x",
        clientSecret: SECRET,
      },
      fetch: routeFetch({
        "http://127.0.0.1:9": tokenAnswer,
        "https://10.0.0.1": tokenAnswer,
      }),
      ...(dev ? { allowLoopbackForDevelopment: true } : {}),
    });
  let threw = false;
  try {
    client("http://10.0.0.1/token");
  } catch (error) {
    threw = error instanceof TypeError;
  }
  assert(threw, "supplied metadata is checked like discovered metadata");
  const privateAddress = client("https://10.0.0.1/token");
  await rejects(() => privateAddress.clientCredentials({ resource: API }), {
    name: "OAuthError",
  });
  const loopback = client("http://127.0.0.1:9/token");
  await rejects(() => loopback.clientCredentials({ resource: API }), {
    name: "OAuthError",
  });
  const dev = client("http://127.0.0.1:9/token", true);
  assertEquals(
    (await dev.clientCredentials({ resource: API })).access_token,
    "stolen",
  );
});

// ----- DB-SWP-F16-13.O2: introspection egress (known item) -----

Deno.test("DB-SWP-F16-13.O2: introspection is bounded egress and never follows a redirect", async () => {
  const fetch = platformFetch({
    [ISSUER]: () =>
      new Response(null, {
        status: 307,
        headers: { location: "https://evil.test/steal" },
      }),
    "https://evil.test": () =>
      Response.json({ active: true, sub: "u", aud: API }),
  });
  const options: IntrospectionVerifierOptions = {
    endpoint: `${ISSUER}/introspect`,
    issuer: ISSUER,
    client: {
      method: "client_secret_post",
      clientId: "api",
      clientSecret: SECRET,
    },
    audience: API,
    fetch,
  };
  const verifier = introspectionVerifier(options);
  await rejects(() => verifier.verify("a-token"), { status: 503 });
  assertEquals(
    fetch.reached.filter((url) => url.startsWith("https://evil.test")),
    [],
  );
  let threw = false;
  try {
    introspectionVerifier({
      ...options,
      endpoint: "http://127.0.0.1:9/introspect",
    });
  } catch (error) {
    threw = error instanceof TypeError;
  }
  assert(threw, "http loopback needs the development override");
  introspectionVerifier({
    ...options,
    endpoint: "http://127.0.0.1:9/introspect",
    allowLoopbackForDevelopment: true,
  });
});

Deno.test("DB-SWP-F15-13.O2: introspection options are read once", async () => {
  const options = {
    endpoint: `${ISSUER}/introspect`,
    issuer: ISSUER,
    client: { method: "none" as const, clientId: "api" },
    audience: [API],
    fetch: routeFetch({
      [ISSUER]: () => Response.json({ active: true, sub: "u" }),
    }),
  };
  const verifier = introspectionVerifier(options);
  loose(options).requireAudience = false;
  options.audience.length = 0;
  await rejects(() => verifier.verify("t"), { code: "invalid_token" });
});

// ----- DB-SWP-F4-13.O1: verifyDpopProof freshness (known item) -----

Deno.test("DB-SWP-F4-13.O1: verifyDpopProof needs a replay store or an explicit opt-out", async () => {
  const dpop = await DpopKey.generate({ now: clock.now });
  const proof = await dpop.proof({
    method: "GET",
    url: `${API}/files`,
    now: clock.now,
  });
  const base = { method: "GET", url: `${API}/files`, now: clock.now };
  await rejects(
    () => verifyDpopProof(proof, base as unknown as DpopVerifyOptions),
    { name: "TypeError" },
  );
  const nonce = await DpopNonceIssuer.create({ now: clock.now });
  await rejects(
    () =>
      verifyDpopProof(
        proof,
        { ...base, nonce } as unknown as DpopVerifyOptions,
      ),
    { name: "TypeError" },
  );
  // @ts-expect-error: neither `replay` nor `unsafeNoReplay`
  const _typed: DpopVerifyOptions = base;
  // @ts-expect-error: a nonce alone is replayable
  const _nonceOnly: DpopVerifyOptions = { ...base, nonce };
  const verified = await verifyDpopProof(proof, {
    ...base,
    unsafeNoReplay: true,
  });
  assertEquals(verified.jkt, dpop.jkt);
  const replay = unsafeMemoryReplayStore({ now: clock.now });
  await verifyDpopProof(proof, { ...base, replay });
  await rejects(() => verifyDpopProof(proof, { ...base, replay }), {
    code: "invalid_dpop_proof",
  });
});

// ----- DB-SWP-F4-13.O2: open registration and client credentials -----

Deno.test("DB-SWP-F4-13.O2: open registration does not hand out machine grants", async () => {
  const register = async (
    w: Awaited<ReturnType<typeof world>>,
    grants: string[],
  ) =>
    await w.handle(
      new Request(w.server.endpoint("registration"), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          grant_types: grants,
          response_types: [],
          token_endpoint_auth_method: "client_secret_basic",
        }),
      }),
    );
  const open = await world({ registration: {} });
  for (
    const grant of [
      "client_credentials",
      "urn:ietf:params:oauth:grant-type:token-exchange",
    ]
  ) {
    await oauthError(
      await register(open, [grant]),
      400,
      "invalid_client_metadata",
    );
  }
  const opted = await world({
    registration: {
      grantTypes: ["authorization_code", "refresh_token", "client_credentials"],
    },
  });
  assertEquals((await register(opted, ["client_credentials"])).status, 201);
  let threw = false;
  try {
    await world({ registration: { grantTypes: ["password"] } });
  } catch (error) {
    threw = error instanceof TypeError;
  }
  assert(threw, "a grant the server does not offer is refused");
});

// ----- DB-SWP-F5-13.O1: principals always carry their issuer -----

Deno.test("DB-SWP-F5-13.O1: a resource with several issuers needs the token's", async () => {
  const verifier = {
    verify: (token: string) =>
      Promise.resolve({
        subject: "u",
        scopes: [],
        audience: [API],
        claims: {},
        ...(token === "a" ? { issuer: "https://a.test" } : {}),
        ...(token === "x" ? { issuer: "https://x.test" } : {}),
      }),
  };
  const make = (servers: string[]) =>
    new ResourceServer({
      resource: API,
      authorizationServers: servers,
      verifier,
      dpop: false,
    });
  const request = (token: string) => ({
    method: "GET",
    url: `${API}/files`,
    authorization: `Bearer ${token}`,
    dpop: null,
  });
  const two = make(["https://a.test", "https://b.test"]);
  let threw = false;
  try {
    await two.verify(request("none"));
  } catch (error) {
    threw = error instanceof TypeError;
  }
  assert(threw, "no issuer on a multi-issuer resource is a server error");
  const foreign = await two.verify(request("x"));
  assert(!foreign.ok, "an issuer the resource does not trust is refused");
  const named = await two.verify(request("a"));
  assert(named.ok && named.principal.issuer === "https://a.test", "named");
  const one = await make(["https://a.test"]).verify(request("none"));
  assert(one.ok && one.principal.issuer === "https://a.test", "the only one");
});

Deno.test("DB-MCP-002 gap: oauthSchemes gives one subject at two issuers two principal keys", async () => {
  const issuers: Record<string, string> = {
    a: "https://a.test",
    b: "https://b.test",
    nul: "https://a.test\u0000x",
  };
  const server = new ResourceServer({
    resource: API,
    authorizationServers: ["https://a.test", "https://b.test"],
    verifier: {
      verify: (token: string) =>
        Promise.resolve({
          subject: "alice",
          scopes: [],
          clientId: "app",
          issuer: issuers[token],
          audience: [API],
          claims: {},
        }),
    },
    dpop: false,
  });
  const app = router({ auth: oauthSchemes(server) });
  app.get(
    "/key",
    (c) => c.json({ key: c.principal.key, issuer: c.principal.issuer }),
  );
  const get = (token: string) =>
    app.fetch(
      new Request(`${API}/key`, {
        headers: { authorization: `Bearer ${token}` },
      }),
    );
  const a = await (await get("a")).json();
  const b = await (await get("b")).json();
  assertEquals(a.issuer, "https://a.test");
  assertEquals(b.issuer, "https://b.test");
  assert(typeof a.key === "string" && typeof b.key === "string", "keys");
  assert(a.key !== b.key, `one key for two issuers: ${a.key}`);
  assertEquals((await get("a")).status, 200);
  assertEquals((await (await get("a")).json()).key, a.key, "stable");
  // An issuer outside the list (one with a NUL, say) is refused, not keyed.
  assertEquals((await get("nul")).status, 401);
});

// ----- DB-SWP-F6-13.O1: the adapter uses the router's public URL -----

Deno.test("DB-SWP-F6-13.O1: DPoP verification uses the router's public URL", async () => {
  const nonce = await DpopNonceIssuer.create({ now: clock.now });
  const server = new ResourceServer({
    resource: API,
    authorizationServers: [ISSUER],
    verifier: jwtAccessTokenVerifier({
      issuer: ISSUER,
      audience: API,
      keys: publicJwks([key]),
      now: clock.now,
    }),
    dpop: { replay: unsafeMemoryReplayStore({ now: clock.now }), nonce },
    now: clock.now,
  });
  const app = router({
    auth: oauthSchemes(server),
    publicUrl: { mode: "fixed", origin: API },
  });
  app.get("/files", (c) => c.text(c.principal.subject));
  const dpop = await DpopKey.generate({ now: clock.now });
  const access = (await issueAccessToken(
    key,
    ISSUER,
    {
      subject: "alice",
      clientId: "app",
      scope: [],
      audience: [API],
      jkt: dpop.jkt,
    },
    300,
    clock.now,
  )).token;
  const answer = await app.fetch(
    new Request("http://127.0.0.1:8080/files", {
      headers: {
        authorization: `DPoP ${access}`,
        dpop: await dpop.proof({
          method: "GET",
          url: `${API}/files`,
          accessToken: access,
          nonce: await nonce.current(),
          now: clock.now,
        }),
      },
    }),
  );
  assertEquals([answer.status, await answer.text()], [200, "alice"]);
  let invalidOverride = false;
  try {
    // @ts-expect-error: the header-built override is gone
    oauthSchemes(server, { publicUrl: () => new URL(API) });
  } catch (error) {
    invalidOverride = error instanceof TypeError;
  }
  assert(invalidOverride, "unknown security options fail at runtime too");
});

// ----- DB-SWP-F11-13.O1: client secrets stay inside the server -----

Deno.test("DB-SWP-F11-13.O1: hooks and client() never see a secret or its hash", async () => {
  const w = await world({ registration: {} });
  const configured = await w.server.client("web-app");
  assert(configured !== null, "known");
  assert(!("client_secret" in configured!), "no configured secret");
  assert(Object.isFrozen(configured), "a frozen view");
  const registered = await w.handle(
    new Request(w.server.endpoint("registration"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ redirect_uris: ["https://x.test/cb"] }),
    }),
  );
  const { client_id: id } = await registered.json();
  const stored = await w.server.client(id);
  assert(!("client_secret_hash" in stored!), "no stored hash");
  const answer = await w.handle(post(w.server.endpoint("token"), {
    grant_type: "client_credentials",
    resource: API,
  }, WEB_AUTH));
  assertEquals(answer.status, 200, "the full record still authenticates");
  await w.handle(
    new Request(
      `${w.server.endpoint("authorization")}?${new URLSearchParams({
        client_id: "web-app",
        redirect_uri: "https://web.test/cb",
        response_type: "code",
        code_challenge: "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
        code_challenge_method: "S256",
        resource: API,
      })}`,
    ),
  );
  const seen = w.interactions.at(-1)!.client;
  assert(!("client_secret" in seen), "the interaction hook sees no secret");
});

// ----- DB-SWP-F15-13.O1: the authorization server snapshots options -----

Deno.test("DB-SWP-F15-13.O1: authorization server options are copied when it is made", async () => {
  const scopesSupported = ["read"];
  const audiences: Record<string, string[]> = { api: [API] };
  const keys = [key];
  const w = await world({
    scopesSupported,
    introspection: { audiences },
    keys,
  });
  scopesSupported.push("admin");
  audiences["web-app"] = [API];
  keys.unshift(await generateSigningKey("ES256", "k0"));
  const admin = await w.handle(post(w.server.endpoint("token"), {
    grant_type: "client_credentials",
    scope: "admin",
    resource: API,
  }, WEB_AUTH));
  await oauthError(admin, 400, "invalid_scope");
  const jwks = await (await w.handle(
    new Request(w.server.endpoint("jwks")),
  )).json();
  assertEquals(jwks.keys.map((k: { kid: string }) => k.kid), ["k1"]);
});

Deno.test("DB-REV-OAUTH-7: lists inside frozen option maps are copied too", async () => {
  const audiences = [OTHER_API];
  const allowed = [API, OTHER_API];
  const w = await world({
    introspection: { audiences: Object.freeze({ "web-app": audiences }) },
    resources: Object.freeze({ allowed }),
  });
  audiences.push(API);
  allowed.push("https://evil.test");
  await oauthError(
    await w.handle(post(w.server.endpoint("token"), {
      grant_type: "client_credentials",
      resource: "https://evil.test",
    }, WEB_AUTH)),
    400,
    "invalid_target",
  );
  const issued = await (await w.handle(post(w.server.endpoint("token"), {
    grant_type: "client_credentials",
    resource: API,
  }, WEB_AUTH))).json();
  const answer =
    await (await w.handle(post(w.server.endpoint("introspection"), {
      token: issued.access_token,
    }, WEB_AUTH))).json();
  assertEquals(answer, { active: false });
  // A signing key with a list in its JWK is still the key itself after
  // the snapshot, not a copy its brand check refuses.
  const pair = await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"],
  );
  const jwk = await crypto.subtle.exportKey("jwk", pair.privateKey);
  const listed = await signingKeyFromJwk(
    { ...jwk, kid: "x5c-key", x5c: ["AAAA"] } as Jwk,
    "ES256",
  );
  const withList = await world({ keys: [listed] });
  const jwks = await (await withList.handle(
    new Request(withList.server.endpoint("jwks")),
  )).json();
  assertEquals(jwks.keys[0].kid, "x5c-key");
});

Deno.test("DB-REV-OAUTH-7: prototype keys in client data fail closed, including runtimes with the accessor", () => {
  const client = JSON.parse(
    '{"client_id":"app","redirect_uris":["https://app.test/cb"],"extra":{"__proto__":{"scope":"admin"}}}',
  );
  // Deno has no Object.prototype.__proto__ accessor; workerd does.
  Object.defineProperty(Object.prototype, "__proto__", {
    get() {
      return Object.getPrototypeOf(this);
    },
    set(value) {
      Object.setPrototypeOf(this, value);
    },
    configurable: true,
  });
  let rejected = false;
  try {
    new AuthorizationServer({
      issuer: ISSUER,
      keys: [key],
      store: unsafeMemoryRecordStore(),
      interaction: () => ({ grant: { subject: "u" } }),
      clients: [client],
    });
  } catch (error) {
    rejected = error instanceof TypeError;
  } finally {
    delete (Object.prototype as Record<string, unknown>).__proto__;
  }
  assert(rejected, "prototype-bearing client data is rejected before storage");
});

Deno.test("DB-SWP-F15-13.O1: a server built directly does not share its client arrays", async () => {
  const redirects = ["https://app.test/cb"];
  const server = new AuthorizationServer({
    issuer: ISSUER,
    keys: [key],
    store: unsafeMemoryRecordStore(),
    interaction: () => ({ grant: { subject: "u" } }),
    clients: [{ client_id: "app", redirect_uris: redirects }],
  });
  redirects.push("https://evil.test/cb");
  assertEquals((await server.client("app"))!.redirect_uris, [
    "https://app.test/cb",
  ]);
});

// ----- DB-SWP-F15-13.O3: resource server and verifier snapshots -----

Deno.test("DB-SWP-F15-13.O3: resource server and JWT verifier options are read once", async () => {
  const audience = [API];
  const verifierOptions: JwtAccessTokenVerifierOptions = {
    issuer: ISSUER,
    audience,
    keys: publicJwks([key]),
    now: clock.now,
  };
  const required = ["read"];
  const options: ResourceServerOptions = {
    resource: API,
    authorizationServers: [ISSUER],
    verifier: jwtAccessTokenVerifier(verifierOptions),
    requiredScopes: required,
    dpop: false,
    now: clock.now,
  };
  const server = new ResourceServer(options);
  audience.push("https://other.test");
  required.length = 0;
  loose(options).verifier = { verify: () => ({ subject: "x", scopes: [] }) };
  const mint = async (aud: string, scope: string[]) =>
    (await issueAccessToken(
      key,
      ISSUER,
      {
        subject: "alice",
        clientId: "app",
        scope,
        audience: [aud],
      },
      300,
      clock.now,
    )).token;
  const check = async (token: string) =>
    await server.verify({
      method: "GET",
      url: `${API}/files`,
      authorization: `Bearer ${token}`,
      dpop: null,
    });
  assert(!(await check(await mint("https://other.test", ["read"]))).ok, "aud");
  assert(!(await check(await mint(API, []))).ok, "required scopes");
  assert((await check(await mint(API, ["read"]))).ok, "a good token passes");
  let threw = false;
  try {
    loose(server.metadata).authorization_servers.push("https://evil.test");
  } catch {
    threw = true;
  }
  assert(threw, "the metadata document is frozen");
  let missing = false;
  try {
    jwtAccessTokenVerifier({
      keys: publicJwks([key]),
    } as unknown as JwtAccessTokenVerifierOptions);
  } catch (error) {
    missing = error instanceof TypeError;
  }
  assert(missing, "issuer and audience are required at run time too");
});

// ----- DB-SWP-F15-13.O4: client and session snapshots -----

Deno.test("DB-SWP-F15-13.O4: session options are read once", async () => {
  const options: OAuthSessionOptions = { resource: "https://api.test/v1" };
  const session = new OAuthSession(options);
  loose(options).resource = "https://evil.test";
  loose(options).allowLoopbackForDevelopment = true;
  for (const url of ["https://evil.test/x", "http://127.0.0.1/v1/x"]) {
    let kind: string | undefined;
    try {
      await session.resourceHeaders({ method: "GET", url });
    } catch (error) {
      kind = (error as { kind?: string }).kind;
    }
    assertEquals(kind, "target", url);
  }
});

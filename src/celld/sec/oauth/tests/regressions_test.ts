// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * Regressions for the Daybreak audit findings against `@celld/sec/oauth`, one
 * or more per finding, named by its identifier. Each failed on the code
 * the audit read.
 *
 * @module
 */

import { assert, assertEquals } from "@celld/core/assert";
import { generateKeyPair, type Jwk, sign } from "@celld/sec/jwt";
import {
  egressUrlProblem,
  JWT_BEARER_ASSERTION,
  metadataEgressPolicy,
  OAuthError,
  ProtocolError,
  resourceChallenge,
  resourceCovers,
  secureUrlProblem,
} from "@celld/sec/oauth";
import {
  discoverAuthorizationServer,
  discoverProtectedResource,
  memoryOAuthStore,
  OAuthClient,
  OAuthSession,
  type RegistrationOptions,
  resolveClient,
} from "@celld/sec/oauth/client";
import * as dpopModule from "@celld/sec/oauth/dpop";
import {
  DpopKey,
  DpopNonceIssuer,
  type ReplayStore,
  unsafeMemoryReplayStore,
} from "@celld/sec/oauth/dpop";
import {
  introspectionVerifier,
  jwtAccessTokenVerifier,
  ResourceServer,
  type ResourceServerOptions,
} from "@celld/sec/oauth/resource";
import { oauthSchemes } from "@celld/sec/oauth/router";
import {
  AuthorizationServer,
  generateSigningKey,
  issueAccessToken,
  publicJwks,
  type SigningKey,
  signingKeyFromJwk,
  unsafeMemoryRecordStore,
} from "@celld/sec/oauth/server";
import {
  manualClock,
  routeFetch,
  testResourceServer,
  testUserAgent,
} from "@celld/sec/oauth/testing";
import { router } from "@celld/web/router";
import {
  API,
  authorize,
  body,
  ISSUER,
  oauthError,
  OTHER_API,
  post,
  redeem,
  rejects,
  RS_AUTH,
  SECRET,
  tokenProof,
  WEB_AUTH,
  type World,
  world,
} from "./fixture.ts";

const clock = manualClock(Date.UTC(2026, 8, 25, 12));
const key = await generateSigningKey("ES256", "k1");

async function accessToken(jkt?: string): Promise<string> {
  return (await issueAccessToken(
    key,
    ISSUER,
    {
      subject: "alice",
      clientId: "app",
      scope: ["read"],
      audience: [API],
      ...(jkt === undefined ? {} : { jkt }),
    },
    300,
    clock.now,
  )).token;
}

function verifier() {
  return jwtAccessTokenVerifier({
    issuer: ISSUER,
    audience: API,
    keys: publicJwks([key]),
    now: clock.now,
  });
}

/** Throws unless `work` throws an instance of `type` whose message matches. */
function throws(
  work: () => unknown,
  type: abstract new (...args: never[]) => Error,
  pattern?: RegExp,
): Error {
  try {
    work();
  } catch (error) {
    assert(error instanceof type, `expected ${type.name}, got ${error}`);
    if (pattern !== undefined) {
      assert(pattern.test(error.message), `message: ${error.message}`);
    }
    return error;
  }
  throw new Error(`expected a ${type.name}`);
}

/** A replay store that counts its claims. */
function countingStore(): ReplayStore & { claims: string[] } {
  const inner = unsafeMemoryReplayStore({ now: clock.now });
  const claims: string[] = [];
  return {
    claims,
    claim(key, expiresAt) {
      claims.push(key);
      return inner.claim(key, expiresAt);
    },
  };
}

// DB-OAUTH-003: DPoP needs an explicit replay store or unsafe opt-out, or `false`.

Deno.test("DB-OAUTH-003: a resource server without a dpop choice is refused", () => {
  const base = {
    resource: API,
    authorizationServers: [ISSUER],
    verifier: verifier(),
  };
  const error = throws(
    () => new ResourceServer(base as unknown as ResourceServerOptions),
    TypeError,
  );
  for (const choice of ["dpop: false", "replay", "unsafeNoReplay"]) {
    assert(error.message.includes(choice), `names ${choice}: ${error.message}`);
  }
  for (
    const dpop of [{}, { required: true }, { algorithms: ["ES256"] }, {
      replay: {},
    }, { nonce: {} }]
  ) {
    throws(
      () =>
        new ResourceServer(
          { ...base, dpop } as unknown as ResourceServerOptions,
        ),
      TypeError,
      /replay|nonce/,
    );
  }
  for (
    const dpop of [
      { unsafeNoReplay: false },
      { unsafeNoReplay: true, replay: unsafeMemoryReplayStore() },
    ]
  ) {
    throws(
      () =>
        new ResourceServer(
          { ...base, dpop } as unknown as ResourceServerOptions,
        ),
      TypeError,
      /unsafeNoReplay|choose replay/,
    );
  }
  // Each explicit choice works.
  new ResourceServer({ ...base, dpop: false });
  new ResourceServer({ ...base, dpop: { replay: unsafeMemoryReplayStore() } });
  new ResourceServer({ ...base, dpop: { unsafeNoReplay: true } });
});

Deno.test("DB-OAUTH-003: the in-memory replay store is named unsafe and fails closed when full", async () => {
  assert(!("memoryReplayStore" in dpopModule), "the old name is gone");
  let now = 0;
  const store = unsafeMemoryReplayStore({ now: () => now, maxEntries: 2 });
  assert(await store.claim("a", 100), "a");
  assert(await store.claim("b", 100), "b");
  // Full of live entries: evicting one would let its proof be replayed.
  assert(!(await store.claim("c", 100)), "c is refused, not evicting a");
  assert(!(await store.claim("a", 100)), "a is still remembered");
  // Entries are live through their expiresAt (DB-REV-RTR-1).
  now = 100;
  assert(!(await store.claim("c", 200)), "no room at their expiresAt");
  now = 101;
  assert(await store.claim("c", 200), "room once entries expire");
  for (const maxEntries of [0, -1, NaN, Infinity, 1.5]) {
    throws(() => unsafeMemoryReplayStore({ maxEntries }), RangeError);
  }
});

Deno.test("DB-OAUTH-003: a replayed proof is refused by the resource server", async () => {
  const api = new ResourceServer({
    resource: API,
    authorizationServers: [ISSUER],
    verifier: verifier(),
    dpop: { replay: unsafeMemoryReplayStore({ now: clock.now }) },
    now: clock.now,
  });
  const dpop = await DpopKey.generate({ now: clock.now });
  const access = await accessToken(dpop.jkt);
  const request = {
    method: "GET",
    url: `${API}/files`,
    authorization: `DPoP ${access}`,
    dpop: await dpop.proof({
      method: "GET",
      url: `${API}/files`,
      accessToken: access,
      now: clock.now,
    }),
  };
  assert((await api.verify(request)).ok, "first use");
  const again = await api.verify(request);
  assert(!again.ok, "replay refused");
  assertEquals(again.challenge.error, "invalid_dpop_proof");
});

// DB-JWT-004 (oauth): numeric options are validated at construction.

Deno.test("DB-JWT-004: resource and verifier numbers are checked up front", () => {
  const base = {
    resource: API,
    authorizationServers: [ISSUER],
    verifier: verifier(),
  };
  for (const maxAgeSec of [NaN, Infinity, -1, 0, 1.5, 100_000]) {
    throws(
      () =>
        new ResourceServer({
          ...base,
          dpop: { replay: unsafeMemoryReplayStore(), maxAgeSec },
        }),
      RangeError,
    );
  }
  for (const clockToleranceSec of [NaN, Infinity, -1, 1_000]) {
    throws(
      () =>
        new ResourceServer({
          ...base,
          dpop: { replay: unsafeMemoryReplayStore(), clockToleranceSec },
        }),
      RangeError,
    );
  }
  const introspection = {
    endpoint: `${ISSUER}/introspect`,
    issuer: ISSUER,
    client: { method: "none" as const, clientId: "api" },
    audience: API,
  };
  // A negative maxEntries used to hang the eviction loop forever.
  for (const maxEntries of [-1, NaN, Infinity, 0.5]) {
    throws(
      () => introspectionVerifier({ ...introspection, maxEntries }),
      RangeError,
    );
  }
  for (const cacheMs of [-1, NaN, Infinity]) {
    throws(
      () => introspectionVerifier({ ...introspection, cacheMs }),
      RangeError,
    );
  }
  for (const clockToleranceSec of [NaN, Infinity, -5]) {
    throws(
      () =>
        jwtAccessTokenVerifier({
          issuer: ISSUER,
          audience: API,
          keys: publicJwks([key]),
          clockToleranceSec,
        }),
      RangeError,
    );
  }
});

Deno.test("DB-JWT-004: the introspection cache stays within maxEntries", async () => {
  let calls = 0;
  const verify = introspectionVerifier({
    endpoint: `${ISSUER}/introspect`,
    issuer: ISSUER,
    client: { method: "none", clientId: "api" },
    audience: API,
    maxEntries: 1,
    now: clock.now,
    fetch: () => {
      calls++;
      return Promise.resolve(Response.json({
        active: true,
        sub: "alice",
        aud: API,
        exp: clock.now() / 1000 + 60,
      }));
    },
  });
  await verify.verify("one");
  await verify.verify("two");
  await verify.verify("two");
  assertEquals(calls, 2, "two is cached");
  await verify.verify("one");
  assertEquals(calls, 3, "one was evicted");
});

// Carry-over from WP-02: loopback JWKS only as a named development override.

Deno.test("WP-02 carry-over: http JWKS only on a loopback IP literal, and only for development", () => {
  const options = { issuer: ISSUER, audience: API };
  throws(
    () => jwtAccessTokenVerifier({ ...options, keys: "http://127.0.0.1/jwks" }),
    TypeError,
  );
  jwtAccessTokenVerifier({
    ...options,
    keys: "http://127.0.0.1:8080/jwks",
    allowLoopbackForDevelopment: true,
  });
  // A name is not a literal: `localhost` is refused even for development.
  throws(
    () =>
      jwtAccessTokenVerifier({
        ...options,
        keys: "http://localhost/jwks",
        allowLoopbackForDevelopment: true,
      }),
    TypeError,
  );
  jwtAccessTokenVerifier({ ...options, keys: "https://as.test/jwks" });
});

// WP-03 reconciliation: the resource server verifies and claims each proof
// once when it is exposed through router schemes.

function schemeApp(server: ResourceServer) {
  const app = router({ auth: oauthSchemes(server) });
  app.get(
    "/files",
    (c) => c.json({ subject: c.principal.subject, jkt: c.principal.cnf?.jkt }),
  );
  return app;
}

async function dpopRequest(
  dpop: DpopKey,
  access: string,
  nonce?: string,
): Promise<Request> {
  return new Request(`${API}/files`, {
    headers: {
      authorization: `DPoP ${access}`,
      dpop: await dpop.proof({
        method: "GET",
        url: `${API}/files`,
        accessToken: access,
        nonce,
        now: clock.now,
      }),
    },
  });
}

Deno.test("WP-03 reconcile: oauthSchemes uses the resource server's store and clock, once per proof", async () => {
  const store = countingStore();
  const server = new ResourceServer({
    resource: API,
    authorizationServers: [ISSUER],
    verifier: verifier(),
    dpop: { replay: store },
    now: clock.now,
  });
  assertEquals(server.dpop?.replay, store);
  const app = schemeApp(server);
  const dpop = await DpopKey.generate({ now: clock.now });
  const access = await accessToken(dpop.jkt);
  // The manual clock is 2026-09-25: the resource server's iat check uses it.
  const request = await dpopRequest(dpop, access);
  const response = await app.fetch(request.clone());
  assertEquals(response.status, 200, await response.clone().text());
  assertEquals((await response.json()).jkt, dpop.jkt);
  assertEquals(store.claims.length, 1, `one claim: ${store.claims}`);
  const replayed = await app.fetch(request);
  assertEquals(replayed.status, 401);
  assertEquals(
    resourceChallenge(replayed.headers.get("www-authenticate"), "DPoP")!.error,
    "invalid_dpop_proof",
  );
  await rejects(() => {
    return Promise.resolve(
      // @ts-expect-error the per-isolate fallback store and clock are gone
      oauthSchemes(server, { replay: store, now: clock.now }),
    );
  }, { name: "TypeError" });
});

Deno.test("WP-03 reconcile: nonce-only DPoP is explicitly unsafe and replayable", async () => {
  const nonce = await DpopNonceIssuer.create({ now: clock.now });
  throws(
    () =>
      new ResourceServer({
        resource: API,
        authorizationServers: [ISSUER],
        verifier: verifier(),
        // @ts-expect-error a nonce is not replay prevention
        dpop: { nonce },
        now: clock.now,
      }),
    TypeError,
    /replay store/,
  );
  const server = new ResourceServer({
    resource: API,
    authorizationServers: [ISSUER],
    verifier: verifier(),
    dpop: { nonce, unsafeNoReplay: true },
    now: clock.now,
  });
  const app = schemeApp(server);
  const dpop = await DpopKey.generate({ now: clock.now });
  const access = await accessToken(dpop.jkt);
  const first = await app.fetch(await dpopRequest(dpop, access));
  assertEquals(first.status, 401);
  assertEquals(
    resourceChallenge(first.headers.get("www-authenticate"), "DPoP")!.error,
    "use_dpop_nonce",
  );
  const fresh = first.headers.get("dpop-nonce");
  assert(fresh !== null, "a nonce on the refusal");
  const accepted = await dpopRequest(dpop, access, fresh);
  const second = await app.fetch(accepted.clone());
  assertEquals(second.status, 200);
  assertEquals(second.headers.get("dpop-nonce"), await nonce.current());
  assertEquals(
    (await app.fetch(accepted)).status,
    200,
    "the explicit unsafe mode accepts the identical proof again",
  );
});

Deno.test("WP-03 reconcile: proofVerified skips the proof but not the binding", async () => {
  const server = new ResourceServer({
    resource: API,
    authorizationServers: [ISSUER],
    verifier: verifier(),
    dpop: { replay: unsafeMemoryReplayStore({ now: clock.now }) },
    now: clock.now,
  });
  const dpop = await DpopKey.generate({ now: clock.now });
  const bound = await accessToken(dpop.jkt);
  const skipped = await server.verify({
    method: "GET",
    url: `${API}/files`,
    authorization: `DPoP ${bound}`,
    dpop: null,
    // @ts-expect-error obsolete bypass is intentionally not part of the API
    proofVerified: true,
  });
  assert(
    !skipped.ok,
    "a fabricated verified-proof flag cannot skip proof checks",
  );
  const unbound = await server.verify({
    method: "GET",
    url: `${API}/files`,
    authorization: `DPoP ${await accessToken()}`,
    dpop: null,
    // @ts-expect-error obsolete bypass is intentionally not part of the API
    proofVerified: true,
  });
  assert(!unbound.ok, "an unbound token under DPoP is still refused");
  const noProof = await server.verify({
    method: "GET",
    url: `${API}/files`,
    authorization: `DPoP ${bound}`,
    dpop: null,
  });
  assert(!noProof.ok, "without proofVerified the proof is required");
});

// DB-JWT-001 (oauth): only asymmetric signing keys, made by the helpers.

const HS_JWK: Jwk = {
  kty: "oct",
  k: "c2VjcmV0LXNlY3JldC1zZWNyZXQtc2VjcmV0LXNlY3JldA",
  kid: "hs",
};

async function rejectsWith(
  work: () => Promise<unknown>,
  type: abstract new (...args: never[]) => Error,
): Promise<void> {
  try {
    await work();
  } catch (error) {
    assert(error instanceof type, `expected ${type.name}, got ${error}`);
    return;
  }
  throw new Error(`expected a ${type.name}`);
}

Deno.test("DB-JWT-001: HMAC signing keys are refused before serving", async () => {
  await rejectsWith(() => signingKeyFromJwk(HS_JWK, "HS256"), TypeError);
  await rejectsWith(() => generateSigningKey("HS256"), TypeError);
  const store = unsafeMemoryRecordStore();
  const base = {
    issuer: ISSUER,
    store,
    interaction: () => ({ grant: { subject: "u" } }),
  };
  // A hand-built key, symmetric or not, cannot reach the server.
  const good = await generateSigningKey("ES256", "good");
  const forged = [
    {
      alg: "HS256",
      kid: "hs",
      privateKey: new TextEncoder().encode("secret-secret-secret-secret-sec"),
      publicJwk: HS_JWK,
    },
    { ...good },
    { alg: "ES256", kid: "x", privateKey: good.privateKey, publicJwk: {} },
  ];
  for (const key of forged) {
    throws(
      () =>
        new AuthorizationServer({
          ...base,
          keys: [key as unknown as SigningKey],
        }),
      TypeError,
    );
    throws(() => publicJwks([key as unknown as SigningKey]), TypeError);
  }
  // @ts-expect-error a SigningKey only comes from the helpers
  const literal: SigningKey = {
    alg: "ES256",
    kid: "x",
    privateKey: good.privateKey,
    publicJwk: {},
  };
  assert(literal !== null, "unreachable at run time");
  // What a real server publishes never carries a secret member.
  const server = new AuthorizationServer({
    ...base,
    keys: [good, await generateSigningKey("RS256", "rsa")],
  });
  const jwks = await (await server.jwks(new Request(`${ISSUER}/jwks`))).json();
  for (const jwk of jwks.keys) {
    for (const member of ["k", "d", "p", "q", "dp", "dq", "qi"]) {
      assert(!(member in jwk), `the JWKS has ${member}`);
    }
  }
});

// DB-JWT-002 (oauth): client assertions need iat, and a near exp.

Deno.test("DB-JWT-002: a far-future client assertion is refused", async () => {
  const w = await world();
  const now = Math.floor(w.clock.now() / 1000);
  const tenYears = 10 * 365 * 86400;
  const assertion = async (claims: Record<string, unknown>) =>
    await sign(
      {
        iss: "jwt-app",
        sub: "jwt-app",
        aud: ISSUER,
        jti: crypto.randomUUID(),
        ...claims,
      },
      w.clientKey.privateKey,
      { alg: "ES256", kid: "jwt-app-1" },
    );
  const request = (value: string) =>
    post(w.server.endpoint("token"), {
      grant_type: "client_credentials",
      resource: API,
      client_assertion_type: JWT_BEARER_ASSERTION,
      client_assertion: value,
    });
  for (
    const claims of [
      { iat: now + tenYears, exp: now + tenYears + 60 },
      { exp: now + 60 }, // no iat
      { iat: now - 10, exp: now + 3600 },
      { iat: now - 600, exp: now + 60 }, // older than five minutes
    ]
  ) {
    await oauthError(
      await w.handle(request(await assertion(claims))),
      401,
      "invalid_client",
    );
  }
  const ok = await w.handle(
    request(await assertion({ iat: now, exp: now + 60 })),
  );
  assertEquals(ok.status, 200);
});

// DB-OAUTH-004: defaults go through the same policy as explicit values.

Deno.test("DB-OAUTH-004: default scopes and resources are validated at construction", async () => {
  const base = {
    issuer: ISSUER,
    keys: [await generateSigningKey("ES256", "k")],
    store: unsafeMemoryRecordStore(),
    interaction: () => ({ grant: { subject: "u" } }),
  };
  throws(
    () =>
      new AuthorizationServer({
        ...base,
        scopesSupported: ["read"],
        defaultScopes: ["admin"],
      }),
    TypeError,
  );
  for (
    const resources of [
      { default: ["http://api.test"] },
      { default: ["https://api.test/#x"] },
      { allowed: [API], default: [OTHER_API] },
    ]
  ) {
    throws(() => new AuthorizationServer({ ...base, resources }), TypeError);
  }
  new AuthorizationServer({
    ...base,
    scopesSupported: ["read"],
    defaultScopes: ["read"],
    resources: { allowed: [API], default: [API] },
  });
});

Deno.test("DB-OAUTH-004: a restricted client omitting scope or resource gets no more than it could ask for", async () => {
  const w = await world({
    defaultScopes: ["admin"],
    resources: {
      allowed: (resource, client) =>
        client.client_id !== "narrow-app" || resource === API,
      default: [OTHER_API],
    },
  }, [{
    client_id: "narrow-app",
    client_secret: "narrow-secret-0123456789",
    grant_types: ["client_credentials"],
    scope: "read",
  }]);
  const auth = {
    authorization: `Basic ${btoa("narrow-app:narrow-secret-0123456789")}`,
  };
  const token = (params: Record<string, string>) =>
    w.handle(post(w.server.endpoint("token"), {
      grant_type: "client_credentials",
      ...params,
    }, auth));
  // Explicitly, admin is refused ...
  await oauthError(
    await token({ scope: "admin", resource: API }),
    400,
    "invalid_scope",
  );
  // ... and omitting scope must not hand it over as the default.
  await oauthError(await token({ resource: API }), 400, "invalid_scope");
  // The default resource is outside what this client may name.
  await oauthError(await token({ scope: "read" }), 400, "invalid_target");
  assertEquals((await token({ scope: "read", resource: API })).status, 200);
  // An unrestricted client still gets the defaults.
  const web = await body(
    await w.handle(post(w.server.endpoint("token"), {
      grant_type: "client_credentials",
    }, WEB_AUTH)),
  );
  assertEquals(web.scope, "admin");
});

// DB-OAUTH-005: introspection is default-deny, by audience.

async function introspectAs(
  w: World,
  token: string,
  headers: Record<string, string> = RS_AUTH,
): Promise<Record<string, unknown>> {
  return await body(
    await w.handle(
      post(w.server.endpoint("introspection"), { token }, headers),
    ),
  );
}

Deno.test("DB-OAUTH-005: without a policy no client learns anything", async () => {
  const w = await world();
  const tokens = await body(await redeem(w, await authorize(w, "public-app")));
  const access = tokens.access_token as string;
  assertEquals(await introspectAs(w, access), { active: false });
  assertEquals(await introspectAs(w, access, WEB_AUTH), { active: false });
});

Deno.test("DB-OAUTH-005: a client sees only tokens for its audiences, with minimal claims", async () => {
  const w = await world({
    introspection: { audiences: { api: [API] } },
  });
  const forApi = await body(
    await redeem(w, await authorize(w, "public-app")),
  );
  const answer = await introspectAs(w, forApi.access_token as string);
  assertEquals(answer.active, true);
  assertEquals(answer.aud, API);
  assertEquals(
    Object.keys(answer).sort(),
    ["active", "aud", "client_id", "exp", "iat", "scope", "sub", "token_type"],
  );
  // A token for another resource is invisible to it, and to web-app.
  const other = await body(
    await redeem(
      w,
      await authorize(w, "public-app", { resource: OTHER_API }),
    ),
  );
  assertEquals(
    await introspectAs(w, other.access_token as string),
    { active: false },
  );
  assertEquals(
    await introspectAs(w, forApi.access_token as string, WEB_AUTH),
    { active: false },
  );
  // A hook decides as well, and `claims` widens the answer.
  const hooked = await world({
    introspection: {
      authorize: (client, claims) =>
        client.client_id === "web-app" && claims.aud === OTHER_API,
      claims: ["jti", "iss"],
    },
  });
  const minted = await body(
    await redeem(
      hooked,
      await authorize(hooked, "public-app", { resource: OTHER_API }),
    ),
  );
  const seen = await introspectAs(
    hooked,
    minted.access_token as string,
    WEB_AUTH,
  );
  assertEquals(seen.active, true);
  assertEquals(seen.iss, ISSUER);
  assert(typeof seen.jti === "string", "jti by the allowlist");
  assertEquals(
    await introspectAs(hooked, minted.access_token as string),
    { active: false },
  );
});

Deno.test("DB-REV-OAUTH-3: the introspection verifier takes access tokens only", async () => {
  // A client that both holds users' refresh tokens and introspects (a
  // BFF): its refresh token is active to it, and must not pass as an
  // access token.
  const w = await world({ introspection: { audiences: { "web-app": [API] } } });
  const issued = await body(
    await redeem(w, await authorize(w, "web-app"), {
      client_id: "web-app",
      redirect_uri: "https://web.test/cb",
    }, WEB_AUTH),
  );
  assert(typeof issued.refresh_token === "string", "a refresh token");
  const verifier = introspectionVerifier({
    endpoint: w.server.endpoint("introspection"),
    issuer: ISSUER,
    client: {
      method: "client_secret_basic",
      clientId: "web-app",
      clientSecret: SECRET,
    },
    audience: API,
    cacheMs: 0,
    fetch: (input, init) => w.handle(new Request(input, init)),
    now: w.clock.now,
  });
  assertEquals(
    (await verifier.verify(issued.access_token as string)).subject,
    "user-1",
  );
  await rejects(() => verifier.verify(issued.refresh_token as string), {
    code: "invalid_token",
  });
  // And from any server: only an access token's types pass.
  for (
    const [tokenType, ok] of [
      [undefined, true],
      ["Bearer", true],
      ["bearer", true],
      ["DPoP", true],
      ["access_token", true],
      ["urn:ietf:params:oauth:token-type:access_token", true],
      ["refresh_token", false],
      ["urn:ietf:params:oauth:token-type:refresh_token", false],
      ["id_token", false],
      [7, false],
    ] as const
  ) {
    const answering = introspectionVerifier({
      endpoint: `${ISSUER}/introspect`,
      issuer: ISSUER,
      client: { method: "none", clientId: "api" },
      audience: API,
      cacheMs: 0,
      now: clock.now,
      fetch: () =>
        Promise.resolve(Response.json({
          active: true,
          sub: "alice",
          aud: API,
          exp: clock.now() / 1000 + 60,
          ...(tokenType === undefined ? {} : { token_type: tokenType }),
        })),
    });
    if (ok) {
      assertEquals((await answering.verify("t")).subject, "alice");
    } else {
      await rejects(() => answering.verify("t"), { code: "invalid_token" });
    }
  }
});

// DB-OAUTH-006: reuse of any spent refresh token revokes the family.

Deno.test("DB-OAUTH-006: a refresh token 40 rotations old still revokes the family", async () => {
  const w = await world();
  const refresh = (token: string) =>
    w.handle(post(w.server.endpoint("token"), {
      grant_type: "refresh_token",
      refresh_token: token,
      client_id: "public-app",
    }));
  const first = await body(await redeem(w, await authorize(w, "public-app")));
  let current = first.refresh_token as string;
  for (let i = 0; i < 40; i++) {
    const next = await refresh(current);
    assertEquals(next.status, 200);
    current = (await body(next)).refresh_token as string;
  }
  await oauthError(
    await refresh(first.refresh_token as string),
    400,
    "invalid_grant",
  );
  // The family is gone: the newest token no longer works.
  await oauthError(await refresh(current), 400, "invalid_grant");
});

// DB-OAUTH-007: request bodies are capped while they stream.

/** A chunked body that never ends, counting how often it was pulled. */
function endless(): {
  stream: ReadableStream<Uint8Array>;
  pulls: () => number;
} {
  let pulls = 0;
  const chunk = new TextEncoder().encode(`a=${"x".repeat(1022)}&`);
  return {
    stream: new ReadableStream({
      pull(controller) {
        pulls++;
        controller.enqueue(chunk);
      },
    }),
    pulls: () => pulls,
  };
}

Deno.test("DB-OAUTH-007: endless chunked bodies stop at the endpoint's cap", async () => {
  const w = await world({ registration: {} });
  const cases: [string, string, number][] = [
    [w.server.endpoint("token"), "application/x-www-form-urlencoded", 16],
    [w.server.endpoint("par"), "application/x-www-form-urlencoded", 16],
    [w.server.endpoint("device"), "application/x-www-form-urlencoded", 16],
    [w.server.endpoint("revocation"), "application/x-www-form-urlencoded", 4],
    [
      w.server.endpoint("introspection"),
      "application/x-www-form-urlencoded",
      4,
    ],
    [w.server.endpoint("registration"), "application/json", 64],
  ];
  for (const [url, type, kib] of cases) {
    const body = endless();
    const response = await w.handle(
      new Request(url, {
        method: "POST",
        headers: { "content-type": type },
        body: body.stream,
        duplex: "half",
      } as RequestInit),
    );
    const json = await response.json();
    assertEquals([response.status, json.error], [413, "invalid_request"], url);
    assert(body.pulls() <= kib + 2, `${url} read ${body.pulls()} KiB`);
  }
  // The authorization endpoint's POST form too.
  const body = endless();
  const response = await w.handle(
    new Request(w.server.endpoint("authorization"), {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: body.stream,
      duplex: "half",
    } as RequestInit),
  );
  assertEquals(response.status, 413);
  assert(body.pulls() <= 18, `read ${body.pulls()} KiB`);
});

Deno.test("DB-OAUTH-007: registration JSON is limited in depth and keys", async () => {
  const w = await world({ registration: {} });
  const register = (text: string) =>
    w.handle(
      new Request(w.server.endpoint("registration"), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: text,
      }),
    );
  const deep = `{"redirect_uris":["https://x.test/cb"],"x":${"[".repeat(20)}${
    "]".repeat(20)
  }}`;
  await oauthError(await register(deep), 400, "invalid_client_metadata");
  const wide: Record<string, unknown> = {
    redirect_uris: ["https://x.test/cb"],
  };
  for (let i = 0; i < 300; i++) wide[`k${i}`] = i;
  await oauthError(
    await register(JSON.stringify(wide)),
    400,
    "invalid_client_metadata",
  );
});

// DB-NET-001 (oauth): client keys and metadata documents through egress.

Deno.test("DB-NET-001: jwks_uri on a private address, and oversized jwks, are refused at registration", async () => {
  const w = await world({ registration: {} });
  const register = (metadata: unknown) =>
    w.handle(
      new Request(w.server.endpoint("registration"), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(metadata),
      }),
    );
  for (
    const uri of [
      "https://169.254.169.254/latest/meta-data",
      "https://10.0.0.1/jwks",
      "https://127.0.0.1/jwks",
      "https://[::1]/jwks",
      "http://127.0.0.1/jwks",
    ]
  ) {
    await oauthError(
      await register({
        redirect_uris: ["https://x.test/cb"],
        token_endpoint_auth_method: "private_key_jwt",
        jwks_uri: uri,
      }),
      400,
      "invalid_client_metadata",
    );
  }
  const { publicJwk } = await generateKeyPair("ES256", { kid: "one" });
  const keys = Array.from({ length: 65 }, (_, i) => ({
    ...publicJwk,
    kid: `k${i}`,
  }));
  await oauthError(
    await register({
      redirect_uris: ["https://x.test/cb"],
      token_endpoint_auth_method: "private_key_jwt",
      jwks: { keys },
    }),
    400,
    "invalid_client_metadata",
  );
});

Deno.test("DB-NET-001: client metadata documents are fetched under the egress policy, streamed", async () => {
  const url = "https://tool.test/oauth/client.json";
  const document = JSON.stringify({
    client_id: url,
    client_name: "Tool",
    redirect_uris: ["http://127.0.0.1/cb"],
    token_endpoint_auth_method: "none",
  });
  let mode: "chunked" | "redirect" | "ok" = "chunked";
  let pulls = 0;
  const seen: RequestInit[] = [];
  const w = await world({
    clientIdMetadataDocuments: { cacheSec: 0 },
    fetch: (_input, init) => {
      seen.push(init ?? {});
      if (mode === "redirect") {
        return Promise.resolve(
          new Response(null, {
            status: 302,
            headers: { location: "https://169.254.169.254/" },
          }),
        );
      }
      if (mode === "ok") return Promise.resolve(new Response(document));
      // No Content-Length: only a streamed cap stops this.
      return Promise.resolve(
        new Response(
          new ReadableStream({
            pull(controller) {
              pulls++;
              controller.enqueue(new TextEncoder().encode(" ".repeat(1024)));
            },
          }),
        ),
      );
    },
  });
  const tryIt = async (clientId: string) =>
    (await authorize(w, clientId, { redirect_uri: "http://127.0.0.1/cb" }))
      .response.status;
  assertEquals(await tryIt(url), 400);
  assert(pulls <= 8, `read ${pulls} KiB of an endless document`);
  mode = "redirect";
  assertEquals(await tryIt(url), 400);
  mode = "ok";
  assertEquals(await tryIt(url), 303);
  for (const init of seen) assertEquals(init.redirect, "manual");
  // A private address is never fetched at all.
  const before = seen.length;
  for (
    const id of [
      "https://10.0.0.5/client.json",
      "https://169.254.169.254/client.json",
      "https://127.0.0.1/client.json",
    ]
  ) {
    assertEquals(await tryIt(id), 400, id);
  }
  assertEquals(seen.length, before);
});

// DB-JWT-004 (oauth): the server's lifetimes are checked at construction.

Deno.test("DB-JWT-004: server lifetimes must be finite and in range", async () => {
  const base = {
    issuer: ISSUER,
    keys: [await generateSigningKey("ES256", "k")],
    store: unsafeMemoryRecordStore(),
    interaction: () => ({ grant: { subject: "u" } }),
  };
  const bad: Record<string, unknown>[] = [
    { accessTokenTtlSec: NaN },
    { accessTokenTtlSec: Infinity },
    { accessTokenTtlSec: 0 },
    { codeTtlSec: -1 },
    { refreshTokenTtlSec: NaN },
    { refreshIdleTtlSec: Infinity },
    { parTtlSec: 1.5 },
    { device: { verificationUri: `${ISSUER}/device`, ttlSec: NaN } },
    { device: { verificationUri: `${ISSUER}/device`, intervalSec: -1 } },
    { registration: { secretTtlSec: Infinity } },
    { clientIdMetadataDocuments: { cacheSec: NaN, allowUrl: () => false } },
  ];
  for (const options of bad) {
    throws(
      () => new AuthorizationServer({ ...base, ...options }),
      RangeError,
    );
  }
});

// DB-OAUTH-001: a session sends its tokens to its resource only.

const RESOURCE = `${API}/v1`;

/** An authorization server, a resource at `/v1`, and hosts that should never see a token. */
async function sessionWorld() {
  const w = await world({ resources: { allowed: [RESOURCE] } });
  const api = testResourceServer(w, {
    resource: RESOURCE,
    scopesSupported: ["read"],
    now: w.clock.now,
  });
  let redirectTo: string | null = null;
  const serveApi = async (request: Request) => {
    const metadata = api.handleMetadata(request);
    if (metadata !== null) return metadata;
    if (redirectTo !== null && new URL(request.url).pathname === "/v1/moved") {
      return new Response(null, {
        status: 302,
        headers: { location: redirectTo },
      });
    }
    const result = await api.verifyRequest(request, { scopes: ["read"] });
    if (!result.ok) return result.challenge.toResponse();
    return Response.json({ subject: result.principal.subject });
  };
  const elsewhere: Request[] = [];
  const foreign = (request: Request) => {
    elsewhere.push(request);
    return new Response("thanks", { status: 401 });
  };
  const routes = routeFetch({
    [ISSUER]: w.handle,
    [API]: serveApi,
    "https://evil.test": foreign,
    "https://api.test.evil.test": foreign,
    "http://api.test": foreign,
    "https://api.test:8443": foreign,
  });
  const sent: Request[] = [];
  const fetch = async (input: string | URL | Request, init?: RequestInit) => {
    const request = new Request(input, init);
    sent.push(request.clone());
    const response = await routes(request);
    if (
      request.redirect === "error" && response.status >= 300 &&
      response.status < 400
    ) {
      throw new TypeError("a redirect with redirect: error");
    }
    return response;
  };
  const session = new OAuthSession({
    resource: RESOURCE,
    redirectUri: "https://app.test/cb",
    registration: { preregistered: { [ISSUER]: { client_id: "public-app" } } },
    userAgent: testUserAgent(routes),
    fetch,
    now: w.clock.now,
  });
  return {
    w,
    session,
    sent,
    elsewhere,
    redirect: (to: string) => {
      redirectTo = to;
    },
  };
}

async function refusedTarget(work: () => Promise<unknown>): Promise<void> {
  try {
    await work();
  } catch (error) {
    assert(error instanceof OAuthError, `an OAuthError, got ${error}`);
    assertEquals(error.kind, "target", error.message);
    return;
  }
  throw new Error("expected the target to be refused");
}

Deno.test("DB-OAUTH-001: resourceFetch refuses every URL its resource does not cover, before any header", async () => {
  const { session, sent, elsewhere } = await sessionWorld();
  const ok = await session.resourceFetch(`${RESOURCE}/files`);
  assertEquals(ok.status, 200);
  assertEquals((await ok.json()).subject, "user-1");
  assertEquals(sent.at(-1)!.redirect, "error");
  const before = sent.length;
  for (
    const url of [
      "https://evil.test/v1/files", // cross-origin
      "https://api.test.evil.test/v1/files", // sibling origin
      "https://api.test:8443/v1/files", // another port
      `${API}/v1x/files`, // path escape at a non-boundary
      `${API}/v1/../admin`, // dot segments
      `${API}/v1/%2e%2e/admin`, // encoded dot segments
      `${API}/v1/..%2fadmin`, // DB-REV-OAUTH-5: an encoded slash
      `${API}/v1%2F..%2Fadmin`,
      `${API}/v1/..%5cadmin`, // an encoded backslash
      `${API}/v1/%2E./admin`, // an encoded dot
      `${API}/admin`,
      "http://api.test/v1/files", // downgrade
      "https://user:pw@api.test/v1/files", // embedded credentials
    ]
  ) {
    await refusedTarget(() => session.resourceFetch(url));
    await refusedTarget(() => session.resourceHeaders({ method: "GET", url }));
    await refusedTarget(() => session.resourceFetch(new Request(url)));
  }
  assertEquals(sent.length, before, "nothing was sent");
  assertEquals(elsewhere.length, 0);
  // DB-REV-OAUTH-5: a resource with a query covers only that query, and
  // escapes in the query (not the path) are no concern.
  const tenant = `${API}/v1?tenant=a`;
  assertEquals(resourceCovers(tenant, `${API}/v1?tenant=a`), true);
  assertEquals(resourceCovers(tenant, `${API}/v1/files?tenant=a`), true);
  assertEquals(resourceCovers(tenant, `${API}/v1?tenant=b`), false);
  assertEquals(resourceCovers(tenant, `${API}/v1/files`), false);
  assertEquals(resourceCovers(RESOURCE, `${API}/v1/files?q=a%2fb`), true);
  assertEquals(resourceCovers(RESOURCE, `${API}/v1/..%2fadmin`), false);
  assertEquals(
    (await session.resourceFetch(`${RESOURCE}/files?q=a%2fb`)).status,
    200,
  );
  // The raw forms are gone, and only the unsafe ones remain.
  const raw = session as unknown as Record<string, unknown>;
  assertEquals(raw.fetch, undefined);
  assertEquals(raw.headers, undefined);
  assertEquals(typeof raw.unsafeFetch, "function");
  assertEquals(typeof raw.unsafeHeaders, "function");
});

Deno.test("DB-OAUTH-001: a redirect from the resource is never followed with the token", async () => {
  const { session, sent, elsewhere, redirect } = await sessionWorld();
  assertEquals((await session.resourceFetch(`${RESOURCE}/files`)).status, 200);
  redirect("https://evil.test/steal");
  let failed = false;
  try {
    await session.resourceFetch(`${RESOURCE}/moved`);
  } catch {
    failed = true;
  }
  assert(failed, "the redirect fails the request");
  assertEquals(sent.at(-1)!.url, `${RESOURCE}/moved`);
  assertEquals(sent.at(-1)!.redirect, "error");
  assertEquals(elsewhere.length, 0);
});

Deno.test("DB-OAUTH-001: challenge ignores foreign responses and never switches issuers silently", async () => {
  const { w, session, sent } = await sessionWorld();
  assertEquals((await session.resourceFetch(`${RESOURCE}/files`)).status, 200);
  const before = sent.length;
  // A 401 from a URL the resource does not cover is not the resource's.
  const foreign = await session.challenge({
    authContext: await session.resourceHeaders({
      method: "GET",
      url: `${RESOURCE}/files`,
    }),
    status: 401,
    headers: new Headers({
      "www-authenticate":
        'Bearer resource_metadata="https://evil.test/.well-known/oauth-protected-resource"',
    }),
    method: "GET",
    url: "https://evil.test/x",
    attempt: 1,
  });
  assertEquals(foreign, false);
  assertEquals(sent.length, before, "no discovery ran");
  // A covered URL whose challenge points at a document naming another
  // authorization server: the session refuses to switch.
  // Discovery through the legitimate document first.
  const legit = routeFetch({
    [API]: () =>
      Response.json({ resource: RESOURCE, authorization_servers: [ISSUER] }),
    [ISSUER]: w.handle,
    "https://evil.test": () =>
      Response.json({
        resource: RESOURCE,
        authorization_servers: ["https://attacker.test"],
      }),
  });
  const session2 = new OAuthSession({
    resource: RESOURCE,
    redirectUri: "https://app.test/cb",
    registration: { preregistered: { [ISSUER]: { client_id: "public-app" } } },
    fetch: legit,
    now: w.clock.now,
  });
  assertEquals((await session2.discover()).issuer, ISSUER);
  try {
    await session2.challenge({
      authContext: await session2.resourceHeaders({
        method: "GET",
        url: `${RESOURCE}/files`,
      }),
      status: 401,
      headers: new Headers({
        "www-authenticate":
          'Bearer resource_metadata="https://evil.test/.well-known/oauth-protected-resource/v1"',
      }),
      method: "GET",
      url: `${RESOURCE}/files`,
      attempt: 1,
    });
    throw new Error("expected a refusal");
  } catch (error) {
    assert(error instanceof OAuthError, String(error));
    assertEquals(error.kind, "discovery");
  }
  assertEquals(session2.discovery?.issuer, ISSUER, "still the first issuer");
  assert(
    !legit.requests.some((r) => r.url.startsWith("https://attacker.test")),
    "the other server was never contacted",
  );
});

Deno.test("DB-REV-OAUTH-1: a challenge's resource_metadata never widens the session's resource", async () => {
  const w = await world({ resources: { allowed: [RESOURCE] } });
  const BROAD = `${API}/`;
  const prm = (resource: string) =>
    Response.json({ resource, authorization_servers: [ISSUER] });
  const routes = routeFetch({
    [ISSUER]: w.handle,
    [API]: (request) => {
      const path = new URL(request.url).pathname;
      if (path === "/v1/broad-prm") return prm(BROAD);
      if (path.startsWith("/.well-known/")) return prm(RESOURCE);
      return new Response(null, { status: 401 });
    },
    "https://evil.test": (request) =>
      new URL(request.url).pathname === "/exact" ? prm(RESOURCE) : prm(BROAD),
  });
  const session = () =>
    new OAuthSession({
      resource: RESOURCE,
      redirectUri: "https://app.test/cb",
      registration: {
        preregistered: { [ISSUER]: { client_id: "public-app" } },
      },
      userAgent: testUserAgent(routes),
      fetch: routes,
      now: w.clock.now,
    });
  const challenge = async (target: OAuthSession, metadata: string) =>
    target.challenge({
      authContext: await target.resourceHeaders({
        method: "GET",
        url: `${RESOURCE}/files`,
      }),
      status: 401,
      headers: new Headers({
        "www-authenticate": `Bearer resource_metadata="${metadata}"`,
      }),
      method: "GET",
      url: `${RESOURCE}/files`,
      attempt: 1,
    });
  const refused = async (work: () => Promise<unknown>) => {
    try {
      await work();
    } catch (error) {
      assert(error instanceof OAuthError, String(error));
      assertEquals(error.kind, "discovery", error.message);
      return;
    }
    throw new Error("expected a discovery refusal");
  };
  const pinned = session();
  assertEquals((await pinned.discover()).resource, RESOURCE);
  // Another origin's document naming a broader resource, and a same-origin
  // one doing the same: neither moves the session's resource.
  for (const url of ["https://evil.test/prm", `${API}/v1/broad-prm`]) {
    await refused(() => challenge(pinned, url));
    assertEquals(pinned.discovery?.resource, RESOURCE);
  }
  // Before any discovery, another origin's document must name exactly the
  // configured resource.
  await refused(() => challenge(session(), "https://evil.test/prm"));
  const fresh = session();
  assertEquals(await challenge(fresh, "https://evil.test/exact"), true);
  assertEquals(fresh.discovery?.resource, RESOURCE);
  const tokenRequests = routes.requests.filter((r) =>
    r.url.startsWith(`${ISSUER}/`) && r.method === "POST"
  );
  for (const request of tokenRequests) {
    const form = new URLSearchParams(await request.text());
    assert(
      form.getAll("resource").every((r) => r === RESOURCE),
      `only ${RESOURCE} is asked for: ${form}`,
    );
  }
  assert(
    !routes.requests.some((r) =>
      r.url.includes("resource=https%3A%2F%2Fapi.test%2F&")
    ),
    "no authorization for the broader resource",
  );
});

Deno.test("DB-REV-OAUTH-6: a token request that fails its grant spends no DPoP jti", async () => {
  const inner = unsafeMemoryRecordStore({
    now: () => Date.UTC(2026, 8, 25, 12),
  });
  const replays: string[] = [];
  const store: typeof inner = {
    ...inner,
    create: (key, value, expiresAt) => {
      if (key.startsWith("replay:")) replays.push(key);
      return inner.create(key, value, expiresAt);
    },
  };
  const w = await world({ store });
  const key = await DpopKey.generate({ now: w.clock.now });
  for (let i = 0; i < 200; i++) {
    await oauthError(
      await w.handle(post(w.server.endpoint("token"), {
        grant_type: "authorization_code",
        code: `bogus-${i}`,
        code_verifier: "v".repeat(43),
        redirect_uri: "https://app.test/cb",
        client_id: "public-app",
      }, await tokenProof(w, key))),
      400,
      "invalid_grant",
    );
  }
  assertEquals(replays.length, 0, "no replay records for refused grants");
  // A grant that passes spends its proof, once.
  const proof = await tokenProof(w, key);
  const first = await redeem(w, await authorize(w, "public-app"), {}, proof);
  assertEquals(first.status, 200);
  assertEquals(replays.length, 1);
  await oauthError(
    await redeem(w, await authorize(w, "public-app"), {}, proof),
    400,
    "invalid_dpop_proof",
  );
});

// DB-OAUTH-002: registration tokens are bound to the issuer they are for.

Deno.test("DB-OAUTH-002: an initial access token goes only to its own issuer", async () => {
  const seen: (string | null)[] = [];
  const fetch = (input: string | URL | Request, init?: RequestInit) => {
    const request = new Request(input, init);
    seen.push(request.headers.get("authorization"));
    return Promise.resolve(Response.json({ client_id: "issued" }, {
      status: 201,
    }));
  };
  const metadataOf = (issuer: string) => ({
    issuer,
    registration_endpoint: `${issuer}/register`,
  });
  const context = (issuer: string) => ({
    metadata: metadataOf(issuer),
    redirectUris: ["https://app.test/cb"],
    store: memoryOAuthStore(),
    fetch,
  });
  const forms: RegistrationOptions[] = [
    {
      dynamic: { client_name: "Tool" },
      initialAccessTokens: { [ISSUER]: "iat-for-as" },
    },
    {
      dynamic: { client_name: "Tool" },
      initialAccessTokens: (issuer) =>
        issuer === ISSUER ? "iat-for-as" : undefined,
    },
  ];
  for (const options of forms) {
    seen.length = 0;
    // Resource metadata naming an attacker's server gets no token.
    await resolveClient(options, context("https://attacker.test"));
    assertEquals(seen, [null]);
    await resolveClient(options, context(ISSUER));
    assertEquals(seen, [null, "Bearer iat-for-as"]);
  }
  // @ts-expect-error the global token is gone
  const old: RegistrationOptions = { initialAccessToken: "global" };
  assert(old !== null, "unused");
});

// DB-NET-001 (oauth): discovery goes through the egress policy.

Deno.test("DB-NET-001: discovery refuses redirects, big bodies and private addresses", async () => {
  const issuer = "https://as.test";
  let answer: () => Response = () => new Response(null, { status: 404 });
  const urls: string[] = [];
  const fetch = (input: string | URL | Request) => {
    urls.push(input instanceof Request ? input.url : String(input));
    return Promise.resolve(answer());
  };
  answer = () =>
    new Response(null, {
      status: 302,
      headers: { location: "https://169.254.169.254/latest" },
    });
  await refusedDiscovery(() => discoverAuthorizationServer(issuer, { fetch }));
  assert(!urls.some((url) => url.includes("169.254")), "not followed");
  let pulls = 0;
  answer = () =>
    new Response(
      new ReadableStream({
        pull(controller) {
          pulls++;
          controller.enqueue(new TextEncoder().encode(" ".repeat(1024)));
        },
      }),
    );
  await refusedDiscovery(() => discoverAuthorizationServer(issuer, { fetch }));
  assert(pulls <= 3 * 66, `read ${pulls} KiB`);
  urls.length = 0;
  for (
    const target of [
      "https://10.0.0.1",
      "https://127.0.0.1",
      "https://[fd00::1]",
    ]
  ) {
    await refusedDiscovery(() =>
      discoverAuthorizationServer(target, { fetch })
    );
    await refusedDiscovery(() =>
      discoverProtectedResource(`${target}/api`, { fetch })
    );
  }
  await refusedDiscovery(() =>
    discoverProtectedResource(`${API}/api`, {
      fetch,
      resourceMetadataUrl: "https://169.254.169.254/prm",
    })
  );
  assertEquals(urls, [], "private addresses are never fetched");
  // Loopback over http only as the named development override.
  answer = () => Response.json({ issuer: "http://127.0.0.1:8080" });
  await refusedDiscovery(() =>
    discoverAuthorizationServer("http://127.0.0.1:8080", { fetch })
  );
  const local = await discoverAuthorizationServer("http://127.0.0.1:8080", {
    fetch,
    allowLoopbackForDevelopment: true,
  });
  assertEquals(local.issuer, "http://127.0.0.1:8080");
});

async function refusedDiscovery(work: () => Promise<unknown>): Promise<void> {
  try {
    await work();
  } catch (error) {
    assert(error instanceof OAuthError, `an OAuthError, got ${error}`);
    assert(
      error.kind === "discovery" || error.kind === "network",
      error.message,
    );
    return;
  }
  throw new Error("expected discovery to fail");
}

// WP-02 carry-over: http is allowed only to a loopback IP literal.

Deno.test("WP-02 carry-over: secure URLs take http only on loopback IP literals", () => {
  assert(secureUrlProblem("http://localhost/") !== null, "localhost");
  assert(secureUrlProblem("http://app.localhost/") !== null, "*.localhost");
  assertEquals(secureUrlProblem("http://127.0.0.1:8080/"), null);
  assertEquals(secureUrlProblem("http://[::1]/"), null);
  assertEquals(secureUrlProblem("https://localhost/"), null);
});

Deno.test("WP-16 carry-over: egressUrlProblem takes http only where boundedFetch would", async () => {
  const http = "http://127.0.0.1:8080/x";
  // The network alone never allows cleartext, as boundedFetch does not.
  assert(egressUrlProblem(http, "loopback") !== null, "loopback, no flag");
  assert(egressUrlProblem(http, "any") !== null, "any, no flag");
  assert(
    egressUrlProblem(http, { network: "loopback" }) !== null,
    "a policy without the flag",
  );
  assert(
    egressUrlProblem(http, {
      network: "public",
      allowCleartextLoopbackForDevelopment: true,
    }) !== null,
    "the flag off the public network only",
  );
  assertEquals(
    egressUrlProblem(http, {
      network: "loopback",
      allowCleartextLoopbackForDevelopment: true,
    }),
    null,
  );
  assertEquals(
    egressUrlProblem(
      http,
      metadataEgressPolicy({
        allowLoopbackForDevelopment: true,
      }),
    ),
    null,
  );
  assertEquals(egressUrlProblem("https://127.0.0.1/x", "loopback"), null);
  // A server whose egress network is loopback but without cleartext
  // refuses an http jwks_uri at registration, as the fetch would.
  const w = await world({
    registration: {},
    egress: { network: "loopback" },
  });
  const answer = await w.handle(
    new Request(w.server.endpoint("registration"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        token_endpoint_auth_method: "private_key_jwt",
        grant_types: ["client_credentials"],
        jwks_uri: "http://127.0.0.1:9/jwks",
      }),
    }),
  );
  await oauthError(answer, 400, "invalid_client_metadata");
});

// DB-OAUTH-007: answers the library reads are capped while they stream.

function endlessResponse(): { response: Response; pulls: () => number } {
  let pulls = 0;
  return {
    response: new Response(
      new ReadableStream({
        pull(controller) {
          pulls++;
          controller.enqueue(new TextEncoder().encode(" ".repeat(1024)));
        },
      }),
      { headers: { "content-type": "application/json" } },
    ),
    pulls: () => pulls,
  };
}

Deno.test("DB-OAUTH-007: an endless introspection answer is a 503, not a hang", async () => {
  let body = endlessResponse();
  const verifier = introspectionVerifier({
    endpoint: `${ISSUER}/introspect`,
    issuer: ISSUER,
    client: { method: "none", clientId: "api" },
    audience: API,
    fetch: () => {
      body = endlessResponse();
      return Promise.resolve(body.response);
    },
  });
  try {
    await verifier.verify("token");
    throw new Error("expected a refusal");
  } catch (error) {
    assertEquals((error as { status?: number }).status, 503, String(error));
  }
  assert(body.pulls() <= 260, `read ${body.pulls()} KiB`);
});

Deno.test("DB-OAUTH-007: an endless token endpoint answer fails the request", async () => {
  let body = endlessResponse();
  const client = new OAuthClient({
    issuer: ISSUER,
    metadata: { issuer: ISSUER, token_endpoint: `${ISSUER}/token` },
    client: { method: "client_secret_basic", clientId: "c", clientSecret: "s" },
    fetch: () => {
      body = endlessResponse();
      return Promise.resolve(body.response);
    },
  });
  let failed = false;
  try {
    await client.clientCredentials({ resource: API });
  } catch (error) {
    failed = error instanceof OAuthError;
  }
  assert(failed, "an OAuthError");
  assert(body.pulls() <= 260, `read ${body.pulls()} KiB`);
});

// DB-JWT-004 (oauth): the session's numbers are checked at construction.

Deno.test("DB-JWT-004: session options must be finite and in range", () => {
  const base = { resource: API };
  for (
    const options of [
      { refreshSkewMs: NaN },
      { refreshSkewMs: -1 },
      { refreshSkewMs: Infinity },
      { maxAttempts: 0 },
      { maxAttempts: 1.5 },
      { maxAttempts: Infinity },
    ]
  ) {
    throws(() => new OAuthSession({ ...base, ...options }), RangeError);
  }
});

// DB-REV-JWT-3 (oauth): a client's registered keys are not a secret store,
// so private_key_jwt verifies asymmetric algorithms only and registration
// refuses symmetric keys.

Deno.test("DB-REV-JWT-3: registration refuses an oct key or a key with k in jwks", async () => {
  const w = await world({ registration: {} });
  const { publicJwk } = await generateKeyPair("ES256", { kid: "one" });
  for (
    const keys of [
      [HS_JWK],
      [publicJwk, { ...HS_JWK, kid: "second" }],
      [{ ...publicJwk, k: HS_JWK.k }],
    ]
  ) {
    await oauthError(
      await w.handle(
        new Request(w.server.endpoint("registration"), {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            redirect_uris: ["https://x.test/cb"],
            token_endpoint_auth_method: "private_key_jwt",
            jwks: { keys },
          }),
        }),
      ),
      400,
      "invalid_client_metadata",
    );
  }
});

// Review F12, for clients: a client's jwks may publish encryption keys
// beside its signing keys (for encrypted responses); they are skipped.
Deno.test("a client jwks with a public encryption key registers, and its private_key_jwt assertion verifies", async () => {
  const w = await world({
    registration: { grantTypes: ["client_credentials"] },
  });
  const sig = await generateKeyPair("ES256", { kid: "sig" });
  const enc = await generateKeyPair("ES256", { kid: "enc", extractable: true });
  const { alg: _alg, key_ops: _ops, ...encryption } = enc.publicJwk;
  const { key_ops: _privateOps, ext: _ext, ...privateEncryption } = await crypto
    .subtle.exportKey("jwk", enc.privateKey) as Jwk;
  const register = (keys: readonly Jwk[]) =>
    w.handle(
      new Request(w.server.endpoint("registration"), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          token_endpoint_auth_method: "private_key_jwt",
          grant_types: ["client_credentials"],
          jwks: { keys },
        }),
      }),
    );
  const signing = { ...sig.publicJwk, use: "sig" };
  const registered = await register([
    signing,
    { ...encryption, alg: "ECDH-ES", use: "enc" },
  ]);
  assertEquals(registered.status, 201, await registered.clone().text());
  const clientId = (await body(registered)).client_id as string;
  const now = Math.floor(w.clock.now() / 1000);
  const assertion = (key: CryptoKey, kid: string) =>
    sign(
      {
        iss: clientId,
        sub: clientId,
        aud: ISSUER,
        jti: crypto.randomUUID(),
        iat: now,
        exp: now + 60,
      },
      key,
      { alg: "ES256", kid },
    );
  const request = (value: string) =>
    post(w.server.endpoint("token"), {
      grant_type: "client_credentials",
      resource: API,
      client_assertion_type: JWT_BEARER_ASSERTION,
      client_assertion: value,
    });
  const ok = await w.handle(request(await assertion(sig.privateKey, "sig")));
  assertEquals(ok.status, 200, await ok.clone().text());
  // The encryption key verifies nothing, even under its own kid.
  await oauthError(
    await w.handle(request(await assertion(enc.privateKey, "enc"))),
    401,
    "invalid_client",
  );
  for (
    const keys of [
      [signing, { ...privateEncryption, use: "enc" }],
      [signing, { ...privateEncryption, key_ops: ["deriveKey"] }],
      [signing, { ...HS_JWK, alg: "A256KW", use: "enc" }],
      [signing, { ...encryption, use: "enc", k: HS_JWK.k }],
      // Nothing left to verify a private_key_jwt assertion with.
      [{ ...encryption, alg: "ECDH-ES", use: "enc" }],
    ] as Jwk[][]
  ) {
    await oauthError(await register(keys), 400, "invalid_client_metadata");
  }
});

Deno.test("DB-REV-JWT-3: an HS256 client assertion is refused even over a stored oct key", async () => {
  await rejectsWith(
    // @ts-expect-error symmetric algorithms also fail at the public type boundary
    () => world({ assertionAlgorithms: ["ES256", "HS256"] }),
    TypeError,
  );
  await rejectsWith(() =>
    world({}, [{
      client_id: "hmac-app",
      token_endpoint_auth_method: "private_key_jwt",
      jwks: { keys: [HS_JWK] },
      grant_types: ["client_credentials"],
    }]), ProtocolError);
});

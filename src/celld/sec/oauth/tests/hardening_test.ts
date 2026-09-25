// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0
// Promise-returning fixture callbacks intentionally have no asynchronous work.
// deno-lint-ignore-file require-await

import { assert as assertWithMessage, assertEquals } from "@celld/core/assert";
import { generateKeyPair } from "@celld/sec/jwt";
import {
  canonicalResource,
  GRANT_TYPES,
  metadataEgressPolicy,
  OAuthError,
  pkcePair,
  ProtocolError,
  TOKEN_TYPES,
} from "@celld/sec/oauth";
import {
  applyClientAuthentication,
  checkRegistrationOptions,
  GrantCodec,
  isPendingAuthorization,
  memoryOAuthStore,
  OAuthClient,
  type OAuthClientOptions,
  registerClient,
  resolveClient,
} from "@celld/sec/oauth/client";
import {
  DEFAULT_DPOP_ALGORITHMS,
  DPOP_ALGORITHMS,
  DpopKey,
  DpopNonceCache,
  normalizeHtu,
} from "@celld/sec/oauth/dpop";
import {
  introspectionVerifier,
  jwtAccessTokenVerifier,
  ResourceServer,
  type VerifiedToken,
} from "@celld/sec/oauth/resource";
import {
  AUTH_METHODS,
  AuthorizationServer,
  CLIENT_METADATA_MEMBERS,
  type RecordStore,
  registeredClient,
  unsafeMemoryRecordStore,
} from "@celld/sec/oauth/server";
import { routeFetch } from "@celld/sec/oauth/testing";
import {
  API,
  authorize,
  body,
  ISSUER,
  OTHER_API,
  post,
  redeem,
  WEB_AUTH,
  world,
} from "./fixture.ts";

Deno.test("DB-CROSS-001/013 / DB-OAUTH-017/022/023: nested factories reject malformed inputs without getters or network", async () => {
  let getters = 0;
  const getter = {
    get method() {
      getters++;
      return "none";
    },
    clientId: "c",
  };
  await rejects(() => client({ client: getter as never }));
  await rejects(() =>
    client({
      metadata: {
        get issuer() {
          getters++;
          return ISSUER;
        },
      } as never,
    })
  );
  for (
    const options of [
      { dynamic: "false" },
      { dynamic: { dpop_bound_access_tokens: "false" } },
      { preregistered: { [ISSUER]: { client_id: "" } } },
      {
        preregistered: {
          [ISSUER]: {
            client_id: "c",
            client_secret: "s",
            token_endpoint_auth_method: "none",
          },
        },
      },
      { initialAccessTokens: { [ISSUER]: 12 } },
      { allowLoopbackForDevelopment: "false" },
      { egress: { network: "everywhere" } },
      { egress: { json: { maxDepth: -1 } } },
      {
        preregistered: {
          get [ISSUER]() {
            getters++;
            return { client_id: "c" };
          },
        },
      },
    ]
  ) await rejects(() => checkRegistrationOptions(options as never));
  for (
    const options of [
      { now: 1 },
      { fetch: false },
      { dpop: {} },
      { egress: { timeoutMs: NaN } },
    ]
  ) await rejects(() => client(options as never));
  const pair = await generateKeyPair("ES256");
  await rejects(() =>
    client({
      client: {
        method: "private_key_jwt",
        clientId: "c",
        alg: "ES256",
        privateKey: pair.publicKey,
      },
    })
  );
  await rejects(() =>
    client({
      client: {
        method: "private_key_jwt",
        clientId: "c",
        alg: "ES384",
        privateKey: pair.privateKey,
      },
    })
  );
  for (
    const options of [
      { registration: { authMethods: ["invalid"] } },
      { registration: { initialAccessToken: "" } },
      { introspection: { authorize: true } },
      { introspection: { audiences: { c: "https://api.test" } } },
      { introspection: { claims: [""] } },
      { dpop: { algorithms: ["HS256"] } },
      { dpop: { nonce: {} } },
      { assertionAlgorithms: [] },
    ]
  ) await rejects(() => world(options as never));
  const store = memoryOAuthStore();
  await rejects(() =>
    resolveClient({
      preregistered: () => ({
        client_id: "c",
        client_secret: "s",
        token_endpoint_auth_method: "none",
      }),
    }, {
      metadata: { issuer: ISSUER },
      redirectUris: [],
      store,
    })
  );
  await rejects(() =>
    resolveClient({}, {
      metadata: { issuer: ISSUER },
      redirectUris: [],
      store: {
        ...store,
        getClient: async () => ({
          client_id: "",
          token_endpoint_auth_method: "none",
        }),
      },
    })
  );
  assertEquals(getters, 0);
  const w = await world();
  assertEquals(
    await w.server.handle(
      new Request("https://evil.test/.well-known/oauth-authorization-server"),
    ),
    null,
  );
  assertEquals(
    (await w.server.jwks(new Request("https://evil.test/jwks"))).status,
    404,
  );
  const api = new ResourceServer({
    resource: API,
    authorizationServers: [ISSUER],
    dpop: false,
    verifier: {
      verify: async () => ({
        subject: "u",
        audience: [API],
        scopes: [],
        claims: {},
      }),
    },
  });
  const result = await api.verifyRequest(
    new Request(API, { headers: { authorization: "Bearer token" } }),
  );
  assert(result.ok);
  assertEquals(result.headers["cache-control"], "private, no-store");
});

Deno.test("DB-OAUTH-009: signer, entropy and nonce failure preserve the unspent authorization code", async () => {
  for (const failure of ["signer", "entropy", "nonce"]) {
    let armed = false;
    const w = await world({
      dpop: {
        nonce: {
          current: async () => {
            if (armed && failure === "nonce") {
              armed = false;
              throw new Error("injected nonce outage");
            }
            return "valid-nonce";
          },
          check: async () => true,
        },
      },
    });
    const pending = await authorize(w, "public-app");
    const originalSign = crypto.subtle.sign;
    const originalRandom = crypto.getRandomValues;
    crypto.subtle.sign = (...args) => {
      if (armed && failure === "signer") {
        armed = false;
        return Promise.reject(new Error("injected signer outage"));
      }
      return originalSign.apply(crypto.subtle, args);
    };
    crypto.getRandomValues = (value) => {
      if (armed && failure === "entropy") {
        armed = false;
        throw new Error("injected entropy outage");
      }
      return originalRandom.call(crypto, value) as typeof value;
    };
    try {
      armed = true;
      assertEquals((await redeem(w, pending)).status, 500, failure);
      assertEquals((await redeem(w, pending)).status, 200, failure);
    } finally {
      crypto.subtle.sign = originalSign;
      crypto.getRandomValues = originalRandom;
    }
  }
});

Deno.test("DB-CROSS-012: deterministic URL/callback/audience mutation corpus cannot create authority", async () => {
  const c = client();
  const pending = await c.authorizationUrl();
  const callback = `${pending.redirectUri}&state=${pending.state}&code=c&iss=${
    encodeURIComponent(ISSUER)
  }`;
  for (let index = 0; index < 64; index++) {
    for (
      const mutation of [
        callback.replace("app.test", `app.test.evil${index}.test`),
        callback.replace("/cb?", `/cb/${index}?`),
        callback.replace("fixed=1", `fixed=${index + 2}`),
        `${callback}&state=${pending.state}`,
      ]
    ) await rejects(() => c.checkAuthorizationResponse(pending, mutation));
    const path = `/a${index}/~user`;
    assertEquals(
      normalizeHtu(`HTTPS://API.TEST:443/a${index}/%7euser?q=${index}#f`),
      `${API}${path}`,
    );
    assertEquals(canonicalResource(`${API}/a${index}////`), `${API}/a${index}`);
  }
});

Deno.test("DB-OAUTH-001/032: runtime pending provenance cannot be forged, weakened or moved implicitly", async () => {
  const one = client();
  const two = client();
  const pending = await one.authorizationUrl({
    scope: ["read"],
    resource: API,
    extra: { nonce: "nonce" },
  });
  const callback =
    `${pending.redirectUri}&state=${pending.state}&code=code&iss=${
      encodeURIComponent(ISSUER)
    }`;
  assert(isPendingAuthorization(pending));
  assert(!isPendingAuthorization({ ...pending }));
  for (
    const copy of [{ ...pending }, { ...pending, issRequired: false }, {
      ...pending,
      resource: [OTHER_API],
    }]
  ) await rejects(() => one.completeAuthorization(copy, callback));
  await rejects(() => two.checkAuthorizationResponse(pending, callback));
  const restored = two.unsafeRestorePending(
    JSON.parse(JSON.stringify(pending)),
  );
  assertEquals(two.checkAuthorizationResponse(restored, callback), "code");
  await rejects(() =>
    two.unsafeRestorePending({ ...pending, clientId: "different" })
  );
  let getter = 0;
  await rejects(() =>
    two.unsafeRestorePending({
      ...pending,
      extra: {
        get nonce() {
          getter++;
          return "bad";
        },
      },
    })
  );
  assertEquals(getter, 0);
});

Deno.test("DB-CROSS-005: public OAuth registries and object trust roots are immutable", async () => {
  for (
    const registry of [AUTH_METHODS, DEFAULT_DPOP_ALGORITHMS, DPOP_ALGORITHMS]
  ) await rejects(() => (registry as string[]).push("HS256"));
  assertEquals(
    (CLIENT_METADATA_MEMBERS as unknown as { add?: unknown }).add,
    undefined,
  );
  await rejects(() => {
    (GRANT_TYPES as unknown as { authorizationCode: string })
      .authorizationCode = "unsafe";
  });
  const c = client();
  await rejects(() => {
    (c as { issuer: string }).issuer = "https://evil.test";
  });
  const key = await DpopKey.generate();
  await rejects(() => {
    (key as { jkt: string }).jkt = "bad";
  });
  const server = new ResourceServer({
    resource: API,
    authorizationServers: [ISSUER],
    verifier: {
      verify: async () => ({
        subject: "u",
        audience: [API],
        scopes: [],
        claims: {},
      }),
    },
    dpop: false,
  });
  await rejects(() => {
    (server as { resource: string }).resource = OTHER_API;
  });
  assert(
    !(await server.verifyRequest(
      new Request(OTHER_API, { headers: { authorization: "Bearer t" } }),
    )).ok,
  );
});

Deno.test("DB-OAUTH-002/007: custom verifier getters and mutable non-JSON claims never escape", async () => {
  let getters = 0;
  let claims: Record<string, unknown> = {
    get role() {
      getters++;
      return "admin";
    },
  };
  const server = new ResourceServer({
    resource: API,
    authorizationServers: [ISSUER],
    dpop: false,
    verifier: {
      verify: async () => ({
        subject: "u",
        audience: [API],
        scopes: [],
        claims,
      }),
    },
  });
  const request = () =>
    server.verifyRequest(
      new Request(API, { headers: { authorization: "Bearer t" } }),
    );
  assert(!(await request()).ok);
  assertEquals(getters, 0);
  claims = { time: new Date() };
  assert(!(await request()).ok);
  const cycle: Record<string, unknown> = {};
  cycle.self = cycle;
  claims = cycle;
  assert(!(await request()).ok);
});

Deno.test("DB-OAUTH-003/017: per-client resource grants are exact-boolean decisions", async () => {
  const seen: string[] = [];
  const w = await world({
    resources: {
      default: [API],
      allowed: [API, OTHER_API],
      authorize: (context) => {
        seen.push(
          `${context.client.client_id}:${context.grantType}:${context.resource}`,
        );
        return context.resource === API && !context.scope.includes("write");
      },
    },
  });
  const send = (resource: string, scope = "read") =>
    w.server.token(
      post(w.server.endpoint("token"), {
        grant_type: "client_credentials",
        resource,
        scope,
      }, WEB_AUTH),
    );
  assertEquals((await send(API)).status, 200);
  assertEquals((await send(OTHER_API)).status, 400);
  assertEquals((await send(API, "write")).status, 400);
  assert(
    seen.every((value) => value.startsWith("web-app:client_credentials:")),
  );
  const unsafe = await world({
    resources: {
      default: [API],
      authorize: (() => "yes") as unknown as () => boolean,
    },
  });
  assertEquals(
    (await unsafe.server.token(
      post(unsafe.server.endpoint("token"), {
        grant_type: "client_credentials",
      }, WEB_AUTH),
    )).status,
    400,
  );
});

Deno.test("DB-OAUTH-004 / DB-OIDC-005: PAR and codes bind the resolver registration generation", async () => {
  let generation = "chain-1";
  const w = await world({
    resolveClient: async (id) =>
      id === "federated"
        ? {
          client_id: id,
          redirect_uris: ["https://app.test/cb"],
          registration_generation: generation,
          require_pushed_authorization_requests: true,
        }
        : null,
  });
  const { challenge, verifier } = await pkcePair();
  const push = async () =>
    await body(
      await w.server.pushedAuthorization(
        post(w.server.endpoint("par"), {
          client_id: "federated",
          redirect_uri: "https://app.test/cb",
          response_type: "code",
          code_challenge: challenge,
          code_challenge_method: "S256",
          resource: API,
        }),
      ),
    );
  const first = await push();
  generation = "chain-2";
  assertEquals(
    (await w.server.authorize(
      new Request(
        `${
          w.server.endpoint("authorization")
        }?client_id=federated&request_uri=${
          encodeURIComponent(String(first.request_uri))
        }`,
      ),
    )).status,
    400,
  );
  const second = await push();
  const approved = await w.server.authorize(
    new Request(
      `${w.server.endpoint("authorization")}?client_id=federated&request_uri=${
        encodeURIComponent(String(second.request_uri))
      }`,
    ),
  );
  assertEquals(approved.status, 303);
  const code = new URL(approved.headers.get("location")!).searchParams.get(
    "code",
  )!;
  generation = "chain-3";
  const refused = await w.server.token(
    post(w.server.endpoint("token"), {
      grant_type: "authorization_code",
      client_id: "federated",
      redirect_uri: "https://app.test/cb",
      code,
      code_verifier: verifier,
    }),
  );
  assertEquals((await body(refused)).error, "invalid_grant");
});

Deno.test("DB-OAUTH-009: precommit record failures preserve code and refresh authority", async () => {
  for (
    const failure of [
      "get:code:",
      "put:family:",
      "swap:code:",
      "put:spent:",
      "swap:family:",
    ]
  ) {
    let now = () => Date.now();
    const base = unsafeMemoryRecordStore({ now: () => now() });
    let armed = false;
    const trip = (operation: string, key: string) => {
      if (armed && `${operation}:${key}`.startsWith(failure)) {
        armed = false;
        throw new Error("injected record failure");
      }
    };
    const store: RecordStore = {
      get(key) {
        trip("get", key);
        return base.get(key);
      },
      put(key, value, expiry) {
        trip("put", key);
        return base.put(key, value, expiry);
      },
      create(key, value, expiry) {
        trip("create", key);
        return base.create(key, value, expiry);
      },
      swap(key, version, value, expiry) {
        trip("swap", key);
        return base.swap(key, version, value, expiry);
      },
      delete: (key) => base.delete(key),
    };
    const w = await world({ store });
    now = w.clock.now;
    const pending = await authorize(w, "public-app");
    const onRefresh = failure === "put:spent:" || failure === "swap:family:";
    armed = !onRefresh;
    if (!onRefresh) {
      assertEquals((await redeem(w, pending)).status, 500, failure);
    }
    const response = await redeem(w, pending);
    assertEquals(response.status, 200, failure);
    const tokens = await body(response);
    if (onRefresh) {
      armed = true;
      const refresh = () =>
        w.server.token(
          post(w.server.endpoint("token"), {
            grant_type: "refresh_token",
            client_id: "public-app",
            refresh_token: String(tokens.refresh_token),
          }),
        );
      assertEquals((await refresh()).status, 500, failure);
      assertEquals((await refresh()).status, 200, failure);
    }
  }
});

Deno.test("DB-OAUTH-022/027: registration cannot widen redirects or return malformed credentials and diagnostics", async () => {
  const metadata = {
    redirect_uris: ["https://app.test/cb"],
    token_endpoint_auth_method: "none",
  };
  for (
    const answer of [
      { client_id: "" },
      { client_id: "c", client_secret_expires_at: -1 },
      { client_id: "c", client_secret_expires_at: "0" },
      { client_id: "c", token_endpoint_auth_method: "unknown" },
      { client_id: "c", client_secret: "unexpected" },
      { client_id: "c", redirect_uris: ["https://evil.test/cb"] },
      { client_id: "c", registration_client_uri: "https://evil.test/manage" },
    ]
  ) {
    await rejects(() =>
      registerClient(`${ISSUER}/register`, metadata, {
        fetch: async () => Response.json(answer, { status: 201 }),
      })
    );
  }
  const diagnostic = "\n\u001b[31m<script>bad</script>" + "x".repeat(2000);
  const error = await rejects(() =>
    registerClient(`${ISSUER}/register`, metadata, {
      fetch: async () =>
        Response.json({
          error: "invalid_client_metadata",
          error_description: diagnostic,
        }, { status: 400 }),
    })
  );
  assert(error instanceof OAuthError);
  assert(!error.message.includes("script") && !error.message.includes("\n"));
  assertEquals(error.description?.length, 1024);
  const headers = { "cache-control": "public", "retry-after": "1" };
  const protocol = new ProtocolError("invalid_request", {
    description: diagnostic,
    headers,
  });
  headers["retry-after"] = "99";
  assert(
    !protocol.message.includes("\n") && !protocol.message.includes("\u001b"),
  );
  assertEquals(protocol.toResponse().headers.get("retry-after"), "1");
  assertEquals(protocol.toResponse().headers.get("cache-control"), "no-store");
  await rejects(() => new ProtocolError("invalid_request", { status: 200 }));
});

Deno.test("DB-OAUTH-023/025: asymmetric APIs and per-field boundary triplets fail before network", async () => {
  let calls = 0;
  const fetch = async () => {
    calls++;
    return Response.json({ access_token: "t", token_type: "Bearer" });
  };
  const base = {
    method: "client_secret_basic" as const,
    clientId: "c",
    clientSecret: "s",
  };
  for (const length of [4095, 4096]) {
    new OAuthClient({
      issuer: ISSUER,
      client: {
        ...base,
        clientId: "c".repeat(length),
        clientSecret: "s".repeat(length),
      },
    });
  }
  await rejects(() =>
    new OAuthClient({
      issuer: ISSUER,
      client: { ...base, clientId: "c".repeat(4097) },
    })
  );
  await rejects(() =>
    new OAuthClient({
      issuer: ISSUER,
      client: { ...base, clientSecret: "s".repeat(4097) },
    })
  );
  const c = client({ client: base, fetch });
  for (const length of [255, 256]) {
    await c.authorizationUrl({ scope: ["s".repeat(length)] });
  }
  await rejects(() => c.authorizationUrl({ scope: ["s".repeat(257)] }));
  for (const count of [255, 256]) {
    await c.authorizationUrl({
      scope: Array.from({ length: count }, (_, index) => `s${index}`),
    });
  }
  await rejects(() =>
    c.authorizationUrl({
      scope: Array.from({ length: 257 }, (_, index) => `s${index}`),
    })
  );
  for (const length of [4095, 4096]) {
    await c.authorizationUrl({ state: "s".repeat(length) });
  }
  await rejects(() => c.authorizationUrl({ state: "s".repeat(4097) }));
  for (const length of [4095, 4096]) {
    await c.authorizationUrl({
      resource: `https://api.test/${"a".repeat(length - 17)}`,
    });
  }
  await rejects(() =>
    c.authorizationUrl({
      resource: `https://api.test/${"a".repeat(4097 - 17)}`,
    })
  );
  const key = await DpopKey.generate();
  for (const length of [1023, 1024]) {
    await key.proof({ method: "GET", url: API, nonce: "n".repeat(length) });
  }
  await rejects(() =>
    key.proof({ method: "GET", url: API, nonce: "n".repeat(1025) })
  );
  await rejects(() => c.revoke("t".repeat(16_385)));
  await rejects(() => c.introspect("t".repeat(16_385)));
  await rejects(() =>
    c.unsafeRefresh("r".repeat(16_385), {
      issuer: ISSUER,
      clientId: "c",
      resource: API,
      scope: [],
    })
  );
  await rejects(() =>
    jwtAccessTokenVerifier({
      issuer: ISSUER,
      audience: API,
      keys: { keys: [] },
      algorithms: ["HS256"] as never,
    })
  );
  assertEquals(calls, 0);
  for (const length of [16_383, 16_384]) {
    const withToken = client({
      client: base,
      fetch: async () =>
        Response.json({
          access_token: "t".repeat(length),
          token_type: "Bearer",
        }),
    });
    assertEquals(
      (await withToken.clientCredentials({ resource: API })).access_token
        .length,
      length,
    );
  }
  const tooBig = client({
    client: base,
    fetch: async () =>
      Response.json({ access_token: "t".repeat(16_385), token_type: "Bearer" }),
  });
  await rejects(() => tooBig.clientCredentials({ resource: API }));
  await client().ready();
});

function assert(
  condition: unknown,
  message = "expected hardening invariant",
): asserts condition {
  assertWithMessage(condition, message);
}

async function rejects(work: () => unknown): Promise<unknown> {
  try {
    await work();
  } catch (error) {
    return error;
  }
  throw new Error("expected rejection");
}

function client(options: Partial<OAuthClientOptions> = {}): OAuthClient {
  return new OAuthClient({
    issuer: ISSUER,
    client: { method: "none", clientId: "app" },
    redirectUri: "https://app.test/cb?fixed=1",
    metadata: {
      issuer: ISSUER,
      authorization_endpoint: `${ISSUER}/authorize`,
      token_endpoint: `${ISSUER}/token`,
      code_challenge_methods_supported: ["S256"],
    },
    ...options,
  });
}

Deno.test("DB-OAUTH-001: issuer, callback target, static query and duplicate fields bind before network", async () => {
  let calls = 0;
  const c = client({
    fetch: () => {
      calls++;
      throw new Error("unexpected fetch");
    },
  });
  const pending = await c.authorizationUrl({ scope: ["read"], resource: API });
  const callback = new URL(pending.redirectUri);
  callback.searchParams.set("state", pending.state);
  callback.searchParams.set("code", "code");
  await rejects(() => c.checkAuthorizationResponse(pending, callback));
  callback.searchParams.set("iss", ISSUER);
  assertEquals(c.checkAuthorizationResponse(pending, callback), "code");
  for (const field of ["iss", "state", "code", "error", "error_description"]) {
    const duplicate = new URL(callback);
    duplicate.searchParams.append(field, "one");
    duplicate.searchParams.append(field, "two");
    await rejects(() => c.completeAuthorization(pending, duplicate));
  }
  for (
    const invalid of [
      callback.href.replace("app.test", "evil.test"),
      callback.href.replace("/cb?", "/other?"),
      callback.href.replace("fixed=1", "fixed=2"),
      `${callback.href}#fragment`,
    ]
  ) await rejects(() => c.completeAuthorization(pending, invalid));
  assertEquals(calls, 0);
  const legacy = client({ unsafeAllowMissingAuthorizationIssuer: true });
  const old = await legacy.authorizationUrl();
  assertEquals(
    legacy.checkAuthorizationResponse(
      old,
      `${old.redirectUri}&state=${old.state}&code=ok`,
    ),
    "ok",
  );
});

Deno.test("DB-OAUTH-002/007: every verifier result is centrally audience-bound and immutable", async () => {
  const good: VerifiedToken = {
    subject: "u",
    scopes: ["read"],
    audience: [API],
    claims: { nested: { roles: ["reader"] } },
    expiresAt: Date.now() + 60_000,
  };
  let value = good;
  const server = new ResourceServer({
    resource: API,
    authorizationServers: [ISSUER],
    verifier: { verify: () => Promise.resolve(value) },
    dpop: false,
  });
  const verify = () =>
    server.verifyRequest(
      new Request(`${API}/file`, {
        headers: { authorization: "Bearer token" },
      }),
    );
  for (
    const patch of [
      { audience: [] },
      { audience: [OTHER_API] },
      { audience: [API + "/"] },
      { audience: [API.toUpperCase()] },
      { audience: undefined },
      { subject: "" },
      { expiresAt: NaN },
      { expiresAt: Date.now() - 1 },
      { cnf: { jkt: "" } },
      { scopes: ["bad scope"] },
    ]
  ) {
    value = { ...good, ...patch } as VerifiedToken;
    assertEquals((await verify()).ok, false);
  }
  value = good;
  const result = await verify();
  assert(result.ok);
  assert(Object.isFrozen(result.principal.claims));
  assert(
    Object.isFrozen(
      (result.principal.claims.nested as { roles: string[] }).roles,
    ),
  );
  good.scopes as string[];
  (good.scopes as string[]).push("admin");
  assertEquals(result.principal.scopes, ["read"]);
});

Deno.test("DB-OAUTH-003: a default resource does not authorize additional audiences", async () => {
  const w = await world({ resources: { default: [API] } });
  const ok = await w.server.token(
    post(
      w.server.endpoint("token"),
      { grant_type: "client_credentials" },
      WEB_AUTH,
    ),
  );
  assertEquals(ok.status, 200);
  const bad = await w.server.token(
    post(w.server.endpoint("token"), {
      grant_type: "client_credentials",
      resource: OTHER_API,
    }, WEB_AUTH),
  );
  assertEquals((await body(bad)).error, "invalid_target");
  assertEquals(
    (await authorize(w, "public-app", { resource: OTHER_API })).location
      ?.searchParams.get("error"),
    "invalid_target",
  );
  const device = await w.server.deviceAuthorization(
    post(w.server.endpoint("device"), {
      resource: OTHER_API,
    }, WEB_AUTH),
  );
  assertEquals((await body(device)).error, "invalid_target");
});

Deno.test("DB-OAUTH-004/012: all configured client redirects and public keys are validated", async () => {
  for (
    const redirect of [
      "javascript:alert(1)",
      "data:text/plain,x",
      "https://u:p@app.test/cb",
      "http://localhost/cb",
      "http://x.localhost/cb",
      "http://remote.test/cb",
      "https://app.test/cb#frag",
    ]
  ) {
    await rejects(() =>
      registeredClient({ client_id: "app", redirect_uris: [redirect] })
    );
  }
  for (
    const redirect of [
      "https://app.test/cb",
      "http://127.0.0.2:456/cb",
      "http://[::1]:123/cb",
    ]
  ) assert(registeredClient({ client_id: "app", redirect_uris: [redirect] }));
  const pair = await generateKeyPair("ES256", { extractable: true });
  for (const field of ["d", "p", "q", "dp", "dq", "qi", "oth", "k"]) {
    await rejects(() =>
      registeredClient({
        client_id: "app",
        grant_types: ["client_credentials"],
        token_endpoint_auth_method: "private_key_jwt",
        jwks: { keys: [{ ...pair.publicJwk, [field]: "secret" }] },
      })
    );
  }
  const w = await world();
  await rejects(() =>
    new AuthorizationServer({
      issuer: ISSUER,
      keys: w.keys,
      store: w.store,
      interaction: () => ({ deny: {} }),
      clients: [{ client_id: "dup", grant_types: [] }, {
        client_id: "dup",
        grant_types: [],
      }],
    })
  );
});

Deno.test("DB-OAUTH-005: metadata documents require a host policy and singleflight negative misses", async () => {
  const w = await world();
  await rejects(() =>
    new AuthorizationServer({
      issuer: ISSUER,
      keys: w.keys,
      store: w.store,
      interaction: () => ({ deny: {} }),
      clientIdMetadataDocuments: {},
    })
  );
  let fetches = 0;
  const server = new AuthorizationServer({
    issuer: ISSUER,
    keys: w.keys,
    store: w.store,
    interaction: () => ({ deny: {} }),
    clientIdMetadataDocuments: {
      allowUrl: (url) => url.hostname === "client.test",
    },
    fetch: async () => {
      fetches++;
      await Promise.resolve();
      return new Response(null, { status: 404 });
    },
  });
  await Promise.all(
    Array.from(
      { length: 100 },
      () => server.client("https://client.test/metadata"),
    ),
  );
  assertEquals(fetches, 1);
  assertEquals(await server.client("https://client.test/metadata"), null);
  assertEquals(fetches, 1);
  assertEquals(await server.client("https://denied.test/metadata"), null);
  assertEquals(fetches, 1);
});

Deno.test("DB-OAUTH-007/011/026: introspection singleflight, negative cache, bounds and immutable answers", async () => {
  let calls = 0;
  let clock = Date.now();
  let gate: Promise<void> | undefined = undefined;
  const make = (active: boolean) =>
    introspectionVerifier({
      endpoint: `${ISSUER}/introspect`,
      issuer: ISSUER,
      audience: API,
      client: { method: "none", clientId: "rs" },
      now: () => clock,
      requireIssuer: true,
      fetch: async () => {
        calls++;
        await (gate ?? Promise.resolve());
        return Response.json({
          active,
          iss: ISSUER,
          sub: "u",
          aud: API,
          scope: "read",
          exp: clock / 1000 + 60,
          nested: { roles: ["reader"] },
        });
      },
    });
  const inactive = make(false);
  await Promise.all(
    Array.from(
      { length: 100 },
      () => rejects(() => inactive.verify("same-invalid-token")),
    ),
  );
  assertEquals(calls, 1);
  await rejects(() => inactive.verify("same-invalid-token"));
  assertEquals(calls, 1);
  clock += 2100;
  await rejects(() => inactive.verify("same-invalid-token"));
  assertEquals(calls, 2);
  const active = make(true);
  const values = await Promise.all(
    Array.from({ length: 100 }, () => active.verify("same-valid-token")),
  );
  assertEquals(calls, 3);
  assert(Object.isFrozen(values[0].scopes));
  assert(Object.isFrozen(values[0].claims.nested));
  const before = calls;
  const blocked = Promise.withResolvers<void>();
  gate = blocked.promise;
  const many = Promise.all(
    Array.from(
      { length: 100 },
      (_, i) => rejects(() => inactive.verify(`invalid-${i}`)),
    ),
  );
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert(calls - before <= 8, "per-origin concurrent work is capped");
  blocked.resolve();
  await many;
  await rejects(() =>
    introspectionVerifier({
      endpoint: `${ISSUER}/introspect`,
      issuer: "",
      audience: [],
      client: { method: "none", clientId: "rs" },
    })
  );
});

Deno.test("DB-OAUTH-008/013: authentication fields never reach hooks and reserved response fields cannot be injected", async () => {
  const w = await world({
    tokenResponse: async () => ({
      refresh_token: "injected",
      scope: "admin",
      error: "bad",
      issued_token_type: "bad",
      id_token: "valid-extension",
    }),
  });
  const request = await authorize(w, "public-app", {
    client_assertion: "assertion-secret",
    client_assertion_type: "sensitive",
    client_secret: "password",
    prompt: "login",
  });
  const serialized = JSON.stringify(w.interactions);
  assert(
    !serialized.includes("assertion-secret") &&
      !serialized.includes("password") && !serialized.includes("sensitive"),
  );
  assertEquals(w.interactions[0].params.prompt, "login");
  const response = await w.server.token(
    post(w.server.endpoint("token"), {
      grant_type: "client_credentials",
      resource: API,
    }, WEB_AUTH),
  );
  const tokens = await body(response);
  assertEquals(tokens.refresh_token, undefined);
  assertEquals(tokens.error, undefined);
  assertEquals(tokens.issued_token_type, undefined);
  assertEquals(tokens.id_token, "valid-extension");
  assert(request.code !== null);
});

Deno.test("DB-OAUTH-009: signer-extension failures do not consume code or rotate refresh family", async () => {
  let fail = true;
  const w = await world({
    tokenResponse: async () => {
      if (fail) {
        fail = false;
        throw new Error("injected failure");
      }
      return {};
    },
  });
  const pending = await authorize(w, "public-app");
  assertEquals((await redeem(w, pending)).status, 500);
  const tokens = await body(await redeem(w, pending));
  assert(typeof tokens.refresh_token === "string");
  fail = true;
  const refresh = () =>
    w.server.token(
      post(w.server.endpoint("token"), {
        grant_type: "refresh_token",
        client_id: "public-app",
        refresh_token: tokens.refresh_token as string,
      }),
    );
  assertEquals((await refresh()).status, 500);
  assertEquals((await refresh()).status, 200);
});

Deno.test("DB-OAUTH-014: device URL validation and crossing expiry never forwards a token request", async () => {
  for (
    const uri of [
      "javascript:alert(1)",
      "http://remote.test/device",
      "https://u:p@auth.test/device",
      "https://auth.test/device#bad",
    ]
  ) {
    const c = client({
      metadata: {
        issuer: ISSUER,
        token_endpoint: `${ISSUER}/token`,
        device_authorization_endpoint: `${ISSUER}/device`,
      },
      fetch: () =>
        Promise.resolve(
          Response.json({
            device_code: "d",
            user_code: "u",
            verification_uri: uri,
            expires_in: 1,
          }),
        ),
    });
    await rejects(() => c.deviceAuthorization());
  }
  let now = 1000;
  let calls = 0;
  const c = client({
    now: () => now,
    fetch: () => {
      calls++;
      throw new Error("must not poll after expiry");
    },
  });
  await rejects(() =>
    c.pollDeviceToken(
      c.unsafeRestoreDevice({
        issuer: ISSUER,
        clientId: "app",
        resource: [API],
        scope: [],
        device_code: "d",
        user_code: "u",
        verification_uri: `${ISSUER}/device`,
        expires_at: 1500,
        interval: 1,
      }),
      {
        sleep: () => {
          now += 1000;
          return Promise.resolve();
        },
      },
    )
  );
  assertEquals(calls, 0);
});

Deno.test("DB-OAUTH-015: safe exchange enforces source audience, scope and subject before pure delegation", async () => {
  let decisions = 0;
  const w = await world({
    tokenExchange: {
      sourceAudiences: [API],
      authorize: async (context) => {
        decisions++;
        return {
          subject: context.subject.sub as string,
          scope: context.scope,
          audience: [OTHER_API],
        };
      },
    },
  });
  const subject = await body(
    await redeem(w, await authorize(w, "public-app", { scope: "read" })),
  );
  const exchange = (patch: Record<string, string> = {}) =>
    w.server.token(post(w.server.endpoint("token"), {
      grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
      subject_token: subject.access_token as string,
      subject_token_type: TOKEN_TYPES.accessToken,
      scope: "read",
      resource: OTHER_API,
      ...patch,
    }, WEB_AUTH));
  assertEquals((await exchange()).status, 200);
  assertEquals((await exchange({ scope: "admin" })).status, 400);
  assertEquals(
    (await exchange({ subject_token_type: TOKEN_TYPES.refreshToken })).status,
    400,
  );
  assertEquals(decisions, 1);
});

Deno.test("DB-OAUTH-017/018/024/025/028: exact config, shared URL rules and credential egress", async () => {
  await rejects(() =>
    client({ allowBearerFallback: "false" } as unknown as OAuthClientOptions)
  );
  await rejects(() => client({ egres: {} } as unknown as OAuthClientOptions));
  for (
    const url of [
      "https://u:p@api.test/a",
      "data:text/plain,a",
      "file:///tmp/a",
    ]
  ) await rejects(() => normalizeHtu(url));
  assertEquals(
    normalizeHtu("HTTPS://API.TEST:443/a/%7e?q=1#x"),
    "https://api.test/a/~",
  );
  assertEquals(
    canonicalResource("https://API.test/a///"),
    "https://api.test/a",
  );
  assertEquals(metadataEgressPolicy({ egress: { redirects: 1 } }).redirects, 0);
  const w = await world();
  for (
    const paths of [{ token: "token" }, { token: "//evil.test" }, {
      token: "/token?x",
    }, { token: "/authorize" }]
  ) {
    await rejects(() =>
      new AuthorizationServer({
        issuer: ISSUER,
        keys: w.keys,
        store: w.store,
        interaction: () => ({ deny: {} }),
        paths,
      })
    );
  }
});

Deno.test("DB-OAUTH-019: DPoP pairs and nonce insertions fail closed and remain bounded", async () => {
  const a = await generateKeyPair("ES256");
  const b = await generateKeyPair("ES256");
  await rejects(() => DpopKey.fromKeyPair(a.privateKey, b.publicJwk, "ES256"));
  const key = await DpopKey.fromKeyPair(a.privateKey, a.publicJwk, "ES256");
  assert(Object.isFrozen(key.publicJwk));
  const cache = new DpopNonceCache();
  for (const nonce of ["", "bad\nnonce", "x".repeat(1025)]) {
    await rejects(() => cache.set(API, nonce));
  }
  await rejects(() => cache.set("data:text/plain,x", "n"));
  for (let i = 0; i < 257; i++) cache.set(`https://host-${i}.test`, "n");
  assertEquals(cache.get("https://host-0.test"), undefined);
  assertEquals(cache.get("https://host-256.test"), "n");
});

Deno.test("DB-OAUTH-022/027: memory store snapshots and remote descriptions never enter safe errors", async () => {
  const store = memoryOAuthStore();
  const clientInfo = { client_id: "app", client_secret: "secret" };
  await store.setClient(ISSUER, clientInfo);
  clientInfo.client_id = "evil";
  assertEquals((await store.getClient(ISSUER))?.client_id, "app");
  const attack = "\n\x1b[31m<script>" + "x".repeat(2048);
  const error = await rejects(() =>
    registerClient(`${ISSUER}/register`, {
      token_endpoint_auth_method: "none",
      redirect_uris: ["https://app.test/cb"],
    }, {
      fetch: () =>
        Promise.resolve(
          Response.json(
            { error: "invalid_client", error_description: attack },
            { status: 400 },
          ),
        ),
    })
  );
  assert(error instanceof OAuthError);
  assert(!error.message.includes("script") && !error.message.includes("\n"));
  assert((error.description?.length ?? 0) <= 1024);
});

Deno.test("DB-OAUTH-029: limiter refuses before signing and recovers with deterministic admission", async () => {
  let allow = false;
  const w = await world({ limiter: () => allow });
  const request = () =>
    w.server.token(
      post(w.server.endpoint("token"), {
        grant_type: "client_credentials",
        resource: API,
      }, WEB_AUTH),
    );
  assertEquals((await request()).status, 429);
  allow = true;
  assertEquals((await request()).status, 200);
});

Deno.test("DB-OAUTH-032: grants reject fabrication, client generation, resource and refresh expansion; AEAD survives restart", async () => {
  const w = await world();
  const fetch = routeFetch({ [ISSUER]: w.handle });
  const options: OAuthClientOptions = {
    issuer: ISSUER,
    client: { method: "none", clientId: "public-app" },
    redirectUri: "https://app.test/cb",
    fetch,
    now: w.clock.now,
  };
  const c = new OAuthClient(options);
  const pending = await c.authorizationUrl({ scope: ["read"], resource: API });
  const callback = (await w.handle(new Request(pending.url))).headers.get(
    "location",
  )!;
  const grant = await c.completeAuthorization(pending, callback);
  await rejects(() => c.resourceHeaders({ ...grant }, API, `${API}/file`));
  await rejects(() =>
    new OAuthClient(options).resourceHeaders(grant, API, `${API}/file`)
  );
  await rejects(() => c.resourceHeaders(grant, OTHER_API, OTHER_API));
  await rejects(() => c.resourceHeaders(grant, API, "https://evil.test"));
  await rejects(() => c.refresh(grant, { resource: OTHER_API }));
  await rejects(() => c.refresh(grant, { scope: ["admin"] }));
  const key = await crypto.subtle.generateKey(
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
  const codec = new GrantCodec(key, {
    issuer: ISSUER,
    clientId: c.clientId,
    owner: c,
  });
  const sealed = await codec.seal(grant);
  const restored = await codec.open(sealed, w.clock.now());
  assertEquals(
    (await c.resourceHeaders(restored, API, `${API}/file`)).authorization,
    `Bearer ${grant.access_token}`,
  );
  await rejects(() => codec.open(sealed.slice(0, -2) + "zz", w.clock.now()));
  await rejects(() =>
    new GrantCodec(key, { issuer: "https://other.test", clientId: c.clientId })
      .open(sealed, w.clock.now())
  );
  const fresh = await c.refresh(grant);
  await rejects(() => c.refresh(grant));
  assert(fresh.provenance.generation !== grant.provenance.generation);
});

Deno.test("DB-OAUTH-032: low-level refresh is singleflight and ambiguous outcomes cannot resend a rotating credential", async () => {
  const w = await world();
  const routed = routeFetch({ [ISSUER]: w.handle });
  const gate = Promise.withResolvers<void>();
  let refreshes = 0;
  let fail = false;
  const c = new OAuthClient({
    issuer: ISSUER,
    client: { method: "none", clientId: "public-app" },
    redirectUri: "https://app.test/cb",
    now: w.clock.now,
    fetch: async (input, init) => {
      if (
        new URLSearchParams(String(init?.body)).get("grant_type") ===
          "refresh_token"
      ) {
        refreshes++;
        await gate.promise;
        if (fail) throw new Error("ambiguous transport failure");
      }
      return await routed(input, init);
    },
  });
  const pending = await c.authorizationUrl({ scope: ["read"], resource: API });
  const callback = (await w.handle(new Request(pending.url))).headers.get(
    "location",
  )!;
  const grant = await c.completeAuthorization(pending, callback);
  const cancellation = new AbortController();
  const cancelled = c.refresh(grant, { signal: cancellation.signal }).catch((
    error,
  ) => error);
  const waiters = Array.from({ length: 100 }, () => c.refresh(grant));
  await rejects(() => c.refresh(grant, { scope: [] }));
  cancellation.abort(new Error("cancel one waiter"));
  assert((await cancelled) instanceof Error);
  gate.resolve();
  const answers = await Promise.all(waiters);
  assertEquals(refreshes, 1);
  assert(answers.every((answer) => answer === answers[0]));
  await rejects(() => c.refresh(grant));
  fail = true;
  await rejects(() => c.refresh(answers[0]));
  assertEquals(refreshes, 2);
  await rejects(() => c.refresh(answers[0]));
  assertEquals(refreshes, 2, "uncertain rotating refresh is not retransmitted");
  assert(
    (await c.resourceHeaders(answers[0], API, API)).authorization !== undefined,
    "the still-live access token remains usable after a transient refresh failure",
  );
  const codecKey = await crypto.subtle.generateKey(
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
  const codec = new GrantCodec(codecKey, {
    issuer: ISSUER,
    clientId: c.clientId,
    owner: c,
  });
  const resumed = await codec.open(await codec.seal(answers[0]), w.clock.now());
  assertEquals(
    resumed.refresh_token,
    undefined,
    "safe persistence cannot revive uncertain refresh authority",
  );
});

Deno.test("DB-OAUTH-032: independently decoded aliases share refresh, retirement, uncertainty and immutable identity", async () => {
  let calls = 0;
  let fail = false;
  const c = client({
    client: { method: "client_secret_basic", clientId: "c", clientSecret: "s" },
    fetch: async () => {
      calls++;
      await Promise.resolve();
      if (fail) throw new Error("lost response");
      return Response.json({
        access_token: `token-${calls}`,
        refresh_token: `refresh-${calls}`,
        token_type: "Bearer",
      });
    },
  });
  const original = await c.clientCredentials({ resource: API });
  const key = await crypto.subtle.generateKey(
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
  const codec = new GrantCodec(key, {
    issuer: ISSUER,
    clientId: c.clientId,
    owner: c,
  });
  const sealed = await codec.seal(original);
  const aliases = await Promise.all([codec.open(sealed), codec.open(sealed)]);
  const changed = c.unsafeRestoreGrant({
    ...original,
    access_token: "spliced",
  });
  await rejects(() => c.resourceHeaders(changed, API, API));
  await rejects(() => c.refresh(changed));
  assertEquals(calls, 1);
  const pending = c.refresh(aliases[0]);
  const joining = c.refresh(aliases[1]);
  const [fresh, same] = await Promise.all([pending, joining]);
  assert(fresh === same);
  assertEquals(calls, 2);
  await rejects(() => codec.open(sealed));
  await rejects(() => c.resourceHeaders(aliases[1], API, API));
  const nextCiphertext = await codec.seal(fresh);
  const freshAlias = await codec.open(nextCiphertext);
  fail = true;
  await rejects(() => c.refresh(fresh));
  assertEquals(calls, 3);
  await rejects(() => c.refresh(freshAlias));
  const reopened = await codec.open(nextCiphertext);
  await rejects(() => c.refresh(reopened));
  assertEquals(calls, 3);
  await c.resourceHeaders(reopened, API, API);
  const accessOnly = await codec.open(await codec.seal(reopened));
  assertEquals(accessOnly.refresh_token, undefined);
  await c.validateGrant(accessOnly);
  await rejects(() => c.refresh(reopened));
  const abort = new AbortController();
  const waiter = c.refresh(
    c.unsafeRestoreGrant({
      ...fresh,
      provenance: { ...fresh.provenance, generation: "A".repeat(22) },
    }),
    { signal: abort.signal },
  );
  abort.abort(new Error("cancel during identity digest"));
  await rejects(() => waiter);
  assertEquals(
    calls,
    3,
    "abort while awaiting identity performs no network work",
  );
});

Deno.test("DB-OAUTH-032: owner generation capacity has no eviction and is reserved before outbound consumption", async () => {
  let calls = 0;
  const gate = Promise.withResolvers<void>();
  let blocked = false;
  const c = client({
    client: { method: "client_secret_basic", clientId: "c", clientSecret: "s" },
    fetch: async () => {
      calls++;
      if (blocked) await gate.promise;
      return Response.json({
        access_token: `token-${calls}`,
        refresh_token: "refresh",
        token_type: "Bearer",
      });
    },
  });
  const seed = await c.clientCredentials({ resource: API });
  // Rejected foreign provenance must not allocate or modify owner state.
  await rejects(() =>
    c.unsafeRestoreGrant({
      ...seed,
      provenance: {
        ...seed.provenance,
        issuer: OTHER_API,
        generation: "Z".repeat(22),
      },
    })
  );
  const checks: Promise<void>[] = [];
  for (let index = 1; index < 4095; index++) {
    const value = c.unsafeRestoreGrant({
      ...seed,
      provenance: {
        ...seed.provenance,
        generation: String(index).padStart(22, "0"),
      },
    });
    checks.push(c.validateGrant(value));
  }
  await Promise.all(checks); // 4095 live generation records, one place left.
  blocked = true;
  const final = c.clientCredentials({ resource: API });
  await rejects(() => c.clientCredentials({ resource: API }));
  gate.resolve();
  await final;
  assertEquals(calls, 2, "the final capacity slot was reserved before fetch");
  await rejects(() => c.refresh(seed));
  await rejects(() => c.clientCredentials({ resource: API }));
  await rejects(() =>
    c.unsafeRestoreGrant({
      ...seed,
      provenance: { ...seed.provenance, generation: "Y".repeat(22) },
    })
  );
  await c.validateGrant(c.unsafeRestoreGrant(seed));
  assertEquals(calls, 2, "capacity refusals send no credentials");
});

Deno.test("DB-OAUTH-025: credential, device, diagnostic and URL boundary triplets", async () => {
  let calls = 0;
  const metadata = {
    issuer: ISSUER,
    token_endpoint: `${ISSUER}/token`,
    revocation_endpoint: `${ISSUER}/revoke`,
    introspection_endpoint: `${ISSUER}/introspect`,
    device_authorization_endpoint: `${ISSUER}/device`,
    authorization_endpoint: `${ISSUER}/authorize`,
    code_challenge_methods_supported: ["S256"],
  };
  const c = client({
    metadata,
    fetch: async (input) => {
      calls++;
      return String(input).endsWith("/revoke")
        ? new Response(null)
        : Response.json({
          access_token: "token",
          refresh_token: "refresh",
          token_type: "Bearer",
          active: true,
        });
    },
  });
  for (
    const operation of [
      (token: string) =>
        c.unsafeRefresh(token, {
          issuer: ISSUER,
          clientId: c.clientId,
          resource: API,
          scope: [],
        }),
      (token: string) => c.revoke(token),
      (token: string) => c.introspect(token),
      (token: string) =>
        c.tokenExchange({
          subjectToken: token,
          subjectTokenType: TOKEN_TYPES.accessToken,
          resource: API,
        }),
    ]
  ) {
    for (const size of [16_383, 16_384]) {
      const before = calls;
      await operation("x".repeat(size));
      assertEquals(calls, before + 1);
    }
    const before = calls;
    await rejects(() => operation("x".repeat(16_385)));
    assertEquals(calls, before, "oversized credential was not forwarded");
  }
  const deviceBase = {
    device_code: "device",
    user_code: "user",
    verification_uri: `${ISSUER}/verify`,
    verification_uri_complete: `${ISSUER}/verify?code=user`,
    expires_in: 60,
    interval: 1,
  };
  for (
    const field of [
      "device_code",
      "user_code",
      "verification_uri",
      "verification_uri_complete",
    ] as const
  ) {
    for (const size of [4095, 4096, 4097]) {
      const uri = field.startsWith("verification_");
      const value = uri
        ? `${ISSUER}/${"x".repeat(size - ISSUER.length - 1)}`
        : "x".repeat(size);
      const deviceClient = client({
        metadata,
        fetch: async () => {
          calls++;
          return Response.json({ ...deviceBase, [field]: value });
        },
      });
      const before = calls;
      if (size <= 4096) {
        assertEquals(
          (await deviceClient.deviceAuthorization())[field]!.length,
          size,
        );
      } else await rejects(() => deviceClient.deviceAuthorization());
      assertEquals(
        calls,
        before + 1,
        "response validation never polls or follows a device URI",
      );
      const persisted = {
        ...deviceBase,
        [field]: value,
        issuer: ISSUER,
        clientId: deviceClient.clientId,
        resource: [],
        scope: [],
        expires_at: Date.now() + 60000,
      };
      const { expires_in: _expires, ...restore } = persisted;
      if (size <= 4096) deviceClient.unsafeRestoreDevice(restore);
      else await rejects(() => deviceClient.unsafeRestoreDevice(restore));
      assertEquals(
        calls,
        before + 1,
        "oversized restored device values perform no network work",
      );
    }
  }
  for (const size of [1023, 1024, 1025]) {
    const description = "d".repeat(size);
    const error = new OAuthError("token", description, { description });
    assertEquals(error.description!.length, Math.min(size, 1024));
    assertEquals(error.message.length, Math.min(size, 1024));
    const protocol = new ProtocolError("invalid_request", { description });
    assertEquals(
      protocol.toJSON().error_description!.length,
      Math.min(size, 1024),
    );
    const callbackClient = client();
    const pending = await callbackClient.authorizationUrl();
    const callback = `${pending.redirectUri}&state=${pending.state}&iss=${
      encodeURIComponent(ISSUER)
    }&error=access_denied&error_description=${description}`;
    const refused = await rejects(() =>
      callbackClient.completeAuthorization(pending, callback)
    );
    assert(refused instanceof OAuthError);
    assertEquals(refused.description!.length, Math.min(size, 1024));
    assert(!refused.message.includes("dddd"));
  }
  const pending = await c.authorizationUrl();
  const callbackBase = `${pending.redirectUri}&state=${pending.state}&iss=${
    encodeURIComponent(ISSUER)
  }&code=code&padding=`;
  for (const size of [16_383, 16_384, 16_385]) {
    const callback = callbackBase + "x".repeat(size - callbackBase.length);
    const before = calls;
    if (size <= 16_384) {
      assertEquals(c.checkAuthorizationResponse(pending, callback), "code");
    } else await rejects(() => c.completeAuthorization(pending, callback));
    assertEquals(calls, before);
    const extra: Record<string, string> = {
      a: "x".repeat(4096),
      b: "x".repeat(4096),
      c: "x".repeat(4096),
      d: "",
    };
    const base = await c.authorizationUrl({ state: "s".repeat(22), extra });
    extra.d = "x".repeat(size - base.url.length);
    if (size <= 16_384) {
      assertEquals(
        (await c.authorizationUrl({ state: "s".repeat(22), extra })).url.length,
        size,
      );
    } else {await rejects(() =>
        c.authorizationUrl({ state: "s".repeat(22), extra })
      );}
    assertEquals(calls, before);
  }
});

Deno.test("DB-OAUTH-025: private assertions obey the stricter shared JWT wire-limit triplet", async () => {
  const pair = await generateKeyPair("ES256");
  const now = () => 1_800_000_000_000;
  const clientId = "c".repeat(1940);
  let sends = 0;
  for (const size of [8191, 8192, 8193]) {
    let chosen: { kid: string; audience: string } | undefined;
    for (
      let kidLength = 1;
      kidLength <= 128 && chosen === undefined;
      kidLength++
    ) {
      for (
        let audienceLength = 2040;
        audienceLength <= 2048;
        audienceLength++
      ) {
        const kid = "k".repeat(kidLength),
          audience = "a".repeat(audienceLength);
        const header = JSON.stringify({ alg: "ES256", typ: "JWT", kid });
        const payload = JSON.stringify({
          iss: clientId,
          sub: clientId,
          aud: audience,
          iat: now() / 1000,
          exp: now() / 1000 + 60,
          jti: "j".repeat(22),
        });
        if (
          Math.ceil(header.length * 4 / 3) + 1 +
              Math.ceil(payload.length * 4 / 3) + 1 + 86 === size
        ) chosen = { kid, audience };
      }
    }
    assert(
      chosen !== undefined,
      `fixture can represent compact assertion length ${size}`,
    );
    const auth = {
      method: "private_key_jwt" as const,
      clientId,
      privateKey: pair.privateKey,
      alg: "ES256" as const,
      kid: chosen.kid,
      audience: { value: chosen.audience },
    };
    if (size <= 8192) {
      assertEquals(
        (await applyClientAuthentication(auth, ISSUER, `${ISSUER}/token`, now))
          .params.client_assertion.length,
        size,
      );
    } else {await rejects(() =>
        applyClientAuthentication(auth, ISSUER, `${ISSUER}/token`, now)
      );}
    const assertionClient = client({
      client: auth,
      now,
      fetch: async (_input, init) => {
        sends++;
        assertEquals(
          new URLSearchParams(String(init?.body)).get("client_assertion")!
            .length,
          size,
        );
        return Response.json({ access_token: "token", token_type: "Bearer" });
      },
    });
    const before = sends;
    if (size <= 8192) {
      await assertionClient.clientCredentials({ resource: API });
      assertEquals(sends, before + 1);
    } else {
      await rejects(() => assertionClient.clientCredentials({ resource: API }));
      assertEquals(sends, before);
    }
  }
});

Deno.test("DB-OAUTH-032: refresh snapshots attenuation before its identity await and never invokes custom array behavior", async () => {
  let calls = 0;
  let behavior = 0;
  let refreshedScope: string | null = null;
  let refreshedResource: string | null = null;
  const c = client({
    client: { method: "client_secret_basic", clientId: "c", clientSecret: "s" },
    fetch: async (_input, init) => {
      calls++;
      const form = new URLSearchParams(String(init?.body));
      if (form.get("grant_type") === "refresh_token") {
        refreshedScope = form.get("scope");
        refreshedResource = form.get("resource");
      }
      return Response.json({
        access_token: `token-${calls}`,
        refresh_token: "refresh",
        token_type: "Bearer",
      });
    },
  });
  const grant = await c.clientCredentials({ resource: API, scope: ["read"] });
  const originalSignal = new AbortController();
  const options = {
    scope: ["read"],
    resource: [API],
    signal: originalSignal.signal,
  };
  const pending = c.refresh(grant, options);
  options.scope.push("admin");
  options.resource[0] = OTHER_API;
  Object.defineProperty(options, "scope", {
    get() {
      behavior++;
      throw new Error("scope getter");
    },
  });
  Object.defineProperty(options, "resource", {
    get() {
      behavior++;
      throw new Error("resource getter");
    },
  });
  options.signal = AbortSignal.abort(
    new Error("replacement must not affect captured signal"),
  );
  const fresh = await pending;
  assertEquals(refreshedScope, "read");
  assertEquals(refreshedResource, API);
  assertEquals(behavior, 0);
  for (const kind of ["scope", "resource"] as const) {
    const values = [kind === "scope" ? "read" : API];
    Object.defineProperty(values, Symbol.iterator, {
      value: () => {
        behavior++;
        throw new Error("custom iterator");
      },
    });
    const before = calls;
    await rejects(() => c.refresh(fresh, { [kind]: values }));
    assertEquals(calls, before);
    assertEquals(behavior, 0);
  }
});

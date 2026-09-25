// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0
// deno-lint-ignore-file require-await
// Async boundary stubs intentionally settle immediately for deterministic tests.
import { assert, assertEquals } from "@celld/core/assert";
import { decode, generateKeyPair, sign } from "@celld/sec/jwt";
import {
  generateSigningKey,
  type RecordStore,
  unsafeMemoryRecordStore,
} from "@celld/sec/oauth/server";
import { routeFetch } from "@celld/sec/oauth/testing";
import { claimsForScopes, parseClaimsRequest } from "@celld/sec/oidc";
import {
  CookieSealer,
  LoginFlow,
  type LoginOptions,
  OidcClient,
  setCookie,
} from "@celld/sec/oidc/rp";
import { testProvider } from "@celld/sec/oidc/testing";
import {
  checkStatementClaims,
  FederationEntity,
  TrustChainResolver,
  verifyTrustMark,
} from "@celld/sec/oidc/federation";
import {
  boundTokenExchange,
  encryptedSecretStore,
  UpstreamBroker,
} from "@celld/sec/oidc/broker";
import { clock, rejects, seconds } from "./fixture.ts";
import { handlers, node, rebuild } from "./federation_fixture.ts";

const OP = "https://op.test";
const CALLBACK = "https://app.test/callback";
const SECRET = "independent-test-secret-0123456789-abcdef";

Deno.test("bound token exchange validates every policy option", async () => {
  for (
    const options of [
      { sourceAudiences: [] },
      { sourceAudiences: ["https://api.test", "https://api.test"] },
      { sourceAudiences: ["https://api.test"], actors: "gateway" },
      { sourceAudiences: ["https://api.test"], actors: [""] },
      { sourceAudiences: ["https://api.test"], unknown: true },
    ]
  ) {
    await rejects(
      async () => boundTokenExchange(options as never),
      { name: "TypeError" },
    );
  }
});

async function setup(resources: readonly string[] = []) {
  const time = clock();
  const op = await testProvider({
    issuer: OP,
    now: time.now,
    clients: [{ client_id: "app", redirect_uris: [CALLBACK] }],
    resources: { allowed: resources },
  });
  const fetch = routeFetch({ [OP]: op.handle });
  const client = new OidcClient({
    issuer: OP,
    metadata: op.provider.metadata(),
    client: { clientId: "app", method: "none" },
    redirectUri: CALLBACK,
    fetch,
    now: time.now,
    resources,
  });
  const login = async (options: LoginOptions = {}) => {
    const pending = await client.authorizationUrl(options);
    const response = await op.handle(new Request(pending.authorization.url));
    return await client.completeLogin(
      pending,
      response.headers.get("location")!,
    );
  };
  return { time, op, fetch, client, login };
}

Deno.test("DB-OIDC-001/002/022: supplied metadata shares strict endpoint policy and cannot mutate", async () => {
  const { op } = await setup();
  const metadata = structuredClone(op.provider.metadata());
  const options = {
    issuer: OP,
    metadata,
    client: { clientId: "app", method: "none" as const },
    redirectUri: CALLBACK,
  };
  for (
    const endpoint of [
      "javascript:alert(1)",
      "data:text/plain,secret",
      "https://user:pass@op.test/logout",
      "https://127.0.0.1/info",
      "https://169.254.169.254/info",
      "https://op.test/logout#x",
      "http://evil.test/info",
    ]
  ) {
    await rejects(
      async () =>
        new OidcClient({
          ...options,
          metadata: {
            ...metadata,
            userinfo_endpoint: endpoint,
            end_session_endpoint: endpoint,
          },
        }),
      { name: "TypeError" },
    );
  }
  const client = new OidcClient(options);
  (metadata as { userinfo_endpoint: string }).userinfo_endpoint =
    "https://evil.test/info";
  const first = await client.metadata();
  assert(
    Object.isFrozen(first) &&
      Object.isFrozen(first.id_token_signing_alg_values_supported),
    "metadata graph frozen",
  );
  assertEquals((await client.metadata()).userinfo_endpoint, `${OP}/userinfo`);
});

Deno.test("DB-OIDC-003/007: inherited trust-mark rules and malformed statement constraints fail closed", async () => {
  const time = clock();
  const key = await generateKeyPair("ES256", { kid: "key" });
  const jwt = await sign(
    {
      iss: "https://evil.test",
      sub: "https://leaf.test",
      trust_mark_type: "toString",
      iat: seconds(time.now),
      exp: seconds(time.now) + 60,
    },
    key.privateKey,
    { alg: "ES256", kid: "key", typ: "trust-mark+jwt" },
  );
  let calls = 0;
  await rejects(() =>
    verifyTrustMark(jwt, {
      subject: "https://leaf.test",
      trustAnchor: {
        iss: "https://anchor.test",
        trust_mark_issuers: {},
      } as never,
      trustAnchorJwks: { keys: [key.publicJwk] },
      issuerKeys: async () => {
        calls++;
        return { keys: [key.publicJwk] };
      },
      now: time.now,
    }), { code: "trust_mark" });
  assertEquals(calls, 0, "prototype rule rejected before remote key lookup");
  for (
    const constraints of [{ max_path_length: -1 }, { max_path_length: 1.5 }, {
      naming_constraints: { permitted: ["evil..test"] },
      unknown: true,
    }, { allowed_entity_types: "openid_provider" }]
  ) {
    await rejects(
      async () =>
        checkStatementClaims({
          iss: "https://anchor.test",
          sub: "https://leaf.test",
          iat: 1,
          exp: 2,
          jwks: { keys: [key.publicJwk] },
          constraints,
        }),
      { code: "malformed" },
    );
  }
});

Deno.test("DB-OIDC-004/022: naming constraints include immediate intermediate and cached graphs are immutable", async () => {
  const time = clock();
  const anchor = await node("https://anchor.test", { now: time.now });
  const intermediate = await node("https://outside.test", { now: time.now });
  const leaf = await node("https://leaf.allowed.test", { now: time.now });
  rebuild(anchor, {
    now: time.now,
    subordinates: {
      [intermediate.id]: {
        jwks: intermediate.jwks,
        constraints: { naming_constraints: { permitted: [".allowed.test"] } },
      },
    },
  });
  rebuild(intermediate, {
    now: time.now,
    authorityHints: [anchor.id],
    subordinates: { [leaf.id]: { jwks: leaf.jwks } },
  });
  rebuild(leaf, { now: time.now, authorityHints: [intermediate.id] });
  const resolver = new TrustChainResolver({
    trustAnchors: [{ entityId: anchor.id, jwks: anchor.jwks }],
    now: time.now,
    fetch: routeFetch(handlers([anchor, intermediate, leaf])),
  });
  await rejects(() => resolver.resolve(leaf.id), { code: "chain" });
  rebuild(anchor, {
    now: time.now,
    subordinates: { [intermediate.id]: { jwks: intermediate.jwks } },
  });
  const fresh = new TrustChainResolver({
    trustAnchors: [{ entityId: anchor.id, jwks: anchor.jwks }],
    now: time.now,
    fetch: routeFetch(handlers([anchor, intermediate, leaf])),
  });
  const chain = await fresh.resolve(leaf.id);
  assert(
    Object.isFrozen(chain) && Object.isFrozen(chain.claims[0].jwks?.keys),
    "cached chain fully frozen",
  );
  assertEquals(await fresh.resolve(leaf.id), chain);
});

Deno.test("DB-OIDC-008/022: resolved-chain reuse never outlives its bounded cache policy", async () => {
  const time = clock();
  const anchor = await node(OP, {
    now: time.now,
    metadata: { openid_relying_party: { client_name: "before" } },
  });
  const resolver = new TrustChainResolver({
    trustAnchors: [{ entityId: OP, jwks: anchor.jwks }],
    now: time.now,
    fetch: routeFetch(handlers([anchor])),
    cacheTtlSec: 1,
  });
  assertEquals(
    (await resolver.resolve(OP)).metadata.openid_relying_party.client_name,
    "before",
  );
  rebuild(anchor, {
    now: time.now,
    metadata: { openid_relying_party: { client_name: "after" } },
  });
  assertEquals(
    (await resolver.resolve(OP)).metadata.openid_relying_party.client_name,
    "before",
  );
  time.advance(1000);
  assertEquals(
    (await resolver.resolve(OP)).metadata.openid_relying_party.client_name,
    "after",
  );
});

Deno.test("DB-OIDC-006: permanent CAS contention never reports successful revocation", async () => {
  const time = clock();
  const store = {
    ...unsafeMemoryRecordStore({ now: time.now }),
    get: async () => ({
      version: 1,
      value: { subject: "user", ended: false },
      expiresAt: time.now() + 60000,
    }),
    swap: async () => false,
  } as unknown as RecordStore;
  const op = await testProvider({ issuer: OP, now: time.now, store });
  await rejects(() => op.provider.endLoginSession("session"), {
    code: "temporarily_unavailable",
    status: 503,
  });
});

Deno.test("DB-OIDC-008/010: expired federation generation and wrong-origin handlers refuse before protocol work", async () => {
  const { op, time } = await setup();
  const client = new OidcClient({
    issuer: OP,
    metadata: op.provider.metadata(),
    client: { clientId: "app", method: "none" },
    redirectUri: CALLBACK,
    now: time.now,
    validUntil: time.now() + 1,
  });
  await client.metadata();
  time.advance(1);
  await rejects(() => client.metadata(), { kind: "discovery" });
  assertEquals(
    (await op.provider.handle(new Request("https://evil.test/userinfo")))
      ?.status,
    400,
  );
  const signer = await node("https://anchor.test");
  assertEquals(
    (await signer.entity.handle(
      new Request("https://evil.test/.well-known/openid-federation"),
    ))?.status,
    400,
  );
  for (
    const path of [
      "//evil.test/x",
      "@evil.test/x",
      "/../token",
      "/x?y",
      "/x#y",
      "/\\evil",
    ]
  ) {
    await rejects(async () =>
      new FederationEntity({
        entityId: signer.id,
        keys: [signer.key],
        paths: { fetch: path },
      }), { name: "TypeError" });
  }
});

Deno.test("DB-OIDC-009: exported claims parser rejects duplicate/prototype/oversized/deep input", async () => {
  for (
    const text of [
      '{"userinfo":{"__proto__":null}}',
      '{"userinfo":{"email":null,"email":null}}',
      '{"id_token":{"constructor":null}}',
      JSON.stringify({ userinfo: { x: { values: Array(300).fill("x") } } }),
      "[".repeat(50) + "0" + "]".repeat(50),
      " ".repeat(9000) + "{}",
    ]
  ) {
    await rejects(async () => parseClaimsRequest(text), {
      name: "ClaimsRequestError",
    });
  }
  assertEquals(claimsForScopes(["toString", "constructor"]), []);
  const { client, op } = await setup();
  const pending = await client.authorizationUrl({
    claims: { userinfo: { email: { essential: true } } },
  });
  const response = await op.handle(new Request(pending.authorization.url));
  assertEquals(
    new URL(response.headers.get("location")!).searchParams.get("error"),
    "invalid_request",
  );
});

Deno.test("DB-OIDC-011: cookie size/rotation/attribute limits and parallel login cookies", async () => {
  const { client, time } = await setup();
  const sealer = await CookieSealer.create({ secret: SECRET, now: time.now });
  assertEquals(await sealer.unseal("cookie", "x".repeat(5000)), null);
  await rejects(() => sealer.seal("cookie", { x: "x".repeat(5000) }, 60), {
    name: "RangeError",
  });
  await rejects(() => sealer.seal("cookie", {}, Infinity), {
    name: "BoundsError",
  });
  await rejects(
    () =>
      CookieSealer.create({ secret: SECRET, previous: Array(4).fill(SECRET) }),
    { name: "TypeError" },
  );
  for (
    const [name, options] of [
      ["__Host-x", { secure: false }],
      ["__Host-x", { path: "/x" }],
      ["__Secure-x", { secure: false }],
      ["x", { sameSite: "None", secure: false }],
      ["x", { path: "/;Domain=evil.test" }],
    ] as const
  ) {
    await rejects(async () => setCookie(name, "v", options), {
      name: "TypeError",
    });
  }
  const flow = new LoginFlow({ client, sealer });
  const request = new Request("https://app.test/login");
  const first = await flow.start(request);
  const second = await flow.start(request);
  assert(
    first.headers.get("set-cookie")!.split("=")[0] !==
      second.headers.get("set-cookie")!.split("=")[0],
    "tabs use distinct cookies",
  );
  await rejects(
    () =>
      flow.start(
        new Request(request, {
          headers: {
            cookie: Array.from(
              { length: 4 },
              (_, i) => `${flow.cookieName}.${i}=v`,
            ).join("; "),
          },
        }),
      ),
    { kind: "state_mismatch" },
  );
});

Deno.test("DB-OIDC-012/020: unsupported capability matrix fails through static, resolved and dynamic registration", async () => {
  const keys = [await generateSigningKey("ES256", "matrix")];
  const base = {
    client_id: "app",
    redirect_uris: [CALLBACK],
    token_endpoint_auth_method: "none" as const,
  };
  const unsupported: Readonly<Record<string, unknown>>[] = [
    { subject_type: "pairwise" },
    { sector_identifier_uri: "https://app.test/sector.json" },
    { id_token_signed_response_alg: "RS256" },
    { id_token_encrypted_response_alg: "RSA-OAEP-256" },
    { id_token_encrypted_response_enc: "A256GCM" },
    { userinfo_signed_response_alg: "ES256" },
    { userinfo_encrypted_response_alg: "RSA-OAEP-256" },
    { userinfo_encrypted_response_enc: "A256GCM" },
    { request_object_signing_alg: "ES256" }, // Disabled for this provider.
    { request_object_encryption_alg: "RSA-OAEP-256" },
    { request_object_encryption_enc: "A256GCM" },
    { default_max_age: 60 },
    { require_auth_time: true },
    { default_acr_values: ["urn:example:acr:strong"] },
    { frontchannel_logout_uri: "https://app.test/frontchannel" },
    { frontchannel_logout_session_required: true },
    { backchannel_logout_uri: "https://app.test/backchannel" },
    { backchannel_logout_session_required: true },
  ];
  const dynamic = await testProvider({ issuer: OP, keys, registration: {} });
  const register = (metadata: Readonly<Record<string, unknown>>) =>
    dynamic.handle(
      new Request(`${OP}/register`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          redirect_uris: [CALLBACK],
          token_endpoint_auth_method: "none",
          ...metadata,
        }),
      }),
    );
  const par = (handle: (request: Request) => Promise<Response>) =>
    handle(
      new Request(`${OP}/par`, {
        method: "POST",
        body: new URLSearchParams({
          client_id: "app",
          redirect_uri: CALLBACK,
          response_type: "code",
          scope: "openid",
          code_challenge: "A".repeat(43),
          code_challenge_method: "S256",
        }),
      }),
    );
  for (const metadata of unsupported) {
    const label = Object.keys(metadata)[0];
    await rejects(() =>
      testProvider({
        issuer: OP,
        keys,
        clients: [{ ...base, ...metadata }],
      }), { name: "TypeError" });
    const resolved = await testProvider({
      issuer: OP,
      keys,
      resolveClient: async () => ({ ...base, ...metadata }),
    });
    const pushed = await par(resolved.handle);
    assertEquals(pushed.status, 401, `resolved ${label}`);
    assertEquals(
      (await pushed.json()).error,
      "invalid_client",
      `resolved ${label}`,
    );
    assertEquals(
      resolved.interactions.length,
      0,
      `no interaction for ${label}`,
    );
    const registered = await register(metadata);
    assertEquals(registered.status, 400, `dynamic ${label}`);
    assertEquals(
      (await registered.json()).error,
      "invalid_client_metadata",
      `dynamic ${label}`,
    );
  }
  // Positive controls ensure these paths fail for capability policy, not for
  // invalid base registration or an incorrectly constructed PAR request.
  const supported = {
    subject_type: "public",
    id_token_signed_response_alg: "ES256",
  };
  await testProvider({
    issuer: OP,
    keys,
    clients: [{ ...base, ...supported }],
  });
  const resolved = await testProvider({
    issuer: OP,
    keys,
    resolveClient: async () => ({ ...base, ...supported }),
  });
  assertEquals(
    (await par(resolved.handle)).status,
    201,
    "supported resolved client",
  );
  assertEquals(
    (await register(supported)).status,
    201,
    "supported dynamic client",
  );
});

Deno.test("DB-OIDC-015/018: default tokens cannot reach a second resource or a different client generation", async () => {
  const A = "https://a.test/api", B = "https://b.test/api";
  const { client, login, op, fetch } = await setup([A, B]);
  const grant = (await login({ resource: A })).tokens;
  await client.resourceHeaders({ method: "GET", url: A }, grant);
  await rejects(
    () => client.resourceHeaders({ method: "GET", url: B }, grant),
    { kind: "target" },
  );
  const defaultGrant = (await login()).tokens;
  await rejects(
    () => client.resourceHeaders({ method: "GET", url: A }, defaultGrant),
    { kind: "target" },
  );
  const other = new OidcClient({
    issuer: OP,
    metadata: op.provider.metadata(),
    client: { clientId: "app", method: "none" },
    redirectUri: CALLBACK,
    resources: [A],
    fetch,
  });
  await rejects(() => other.resourceHeaders({ method: "GET", url: A }, grant), {
    kind: "token",
  });
  const defaults = await setup();
  await rejects(() => defaults.client.authorizationUrl({ resource: B }), {
    error: "invalid_target",
  });
});

Deno.test("DB-OIDC-019: completeLogin checks present c_hash before returning a grant", async () => {
  const { op, time } = await setup();
  const fetch = routeFetch({
    [OP]: async (request) => {
      const response = await op.handle(request);
      if (
        new URL(request.url).pathname !== "/token" || !response.ok
      ) return response;
      const body = await response.json();
      const token = decode(body.id_token);
      body.id_token = await sign(
        { ...token.payload, c_hash: "wrong" },
        op.keys[0].privateKey,
        { alg: op.keys[0].alg, kid: op.keys[0].kid },
      );
      return Response.json(body);
    },
  });
  const client = new OidcClient({
    issuer: OP,
    metadata: op.provider.metadata(),
    client: { clientId: "app", method: "none" },
    redirectUri: CALLBACK,
    fetch,
    now: time.now,
  });
  const pending = await client.authorizationUrl();
  const answer = await op.handle(new Request(pending.authorization.url));
  await rejects(
    () => client.completeLogin(pending, answer.headers.get("location")!),
    { code: "c_hash" },
  );
});

Deno.test("DB-OIDC-023: broker storage identity is opaque, fixed length and domain separated", async () => {
  const store = await encryptedSecretStore(unsafeMemoryRecordStore(), {
    secret: SECRET,
  });
  const first = await store.identityKey(OP, "alice@example.test");
  assertEquals(first.length, 62);
  assert(
    !first.includes("alice") && !first.includes("op.test"),
    "opaque identity",
  );
  assertEquals(first, await store.identityKey(OP, "alice@example.test"));
  assert(
    first !== await store.identityKey(OP, "bob@example.test"),
    "different subject",
  );
  await rejects(() => store.identityKey(OP, "x".repeat(3000)), {
    name: "TypeError",
  });
});

Deno.test("DB-OIDC-011/013: constructor boundaries reject malformed rotation iterators and broker options", async () => {
  const { client } = await setup();
  const store = unsafeMemoryRecordStore();
  const sealer = await CookieSealer.create({ secret: SECRET });
  const secrets = await encryptedSecretStore(store, { secret: SECRET });
  let read = false;
  const accessor: unknown[] = [];
  Object.defineProperty(accessor, "0", {
    get: () => {
      read = true;
      return SECRET;
    },
    enumerable: true,
  });
  const iterator = {
    [Symbol.iterator]: () => {
      read = true;
      throw new Error("must not iterate");
    },
  };
  for (const previous of [null, {}, iterator, accessor, new Array(1)]) {
    await rejects(
      () =>
        CookieSealer.create({ secret: SECRET, previous: previous as never }),
      { name: "TypeError" },
    );
    await rejects(
      () =>
        encryptedSecretStore(store, {
          secret: SECRET,
          previous: previous as never,
        }),
      { name: "TypeError" },
    );
  }
  assertEquals(read, false, "no untrusted getter or iterator ran");
  for (
    const change of [
      { keepSec: Infinity },
      { keepSec: -1 },
      { secure: "false" },
      { subject: true },
      { scope: ["a", "a"] },
      { secrets: {} },
      { insecure: true },
    ]
  ) {
    await rejects(async () =>
      new UpstreamBroker(
        { upstream: client, sealer, secrets, ...change } as never,
      ), { name: change.keepSec === undefined ? "TypeError" : "BoundsError" });
  }
  await rejects(
    async () => setCookie("x", "v", { path: "/" + "x".repeat(5000) }),
    { name: "TypeError" },
  );
  const op = await testProvider({ issuer: OP });
  await rejects(
    () =>
      op.provider.endLoginSession("session", { signal: AbortSignal.abort() }),
    { name: "AbortError" },
  );
});

Deno.test("DB-OIDC-012: UserInfo content type and exact signed algorithm are independent from ID tokens", async () => {
  const { op, time } = await setup();
  const metadata = {
    ...op.provider.metadata(),
    userinfo_signing_alg_values_supported: ["ES256"],
  };
  let mode = "signed";
  const fetch = routeFetch({
    [OP]: async (request) => {
      if (new URL(request.url).pathname !== "/userinfo") {
        return await op.handle(request);
      }
      if (mode === "json") return Response.json({ sub: "alice" });
      if (mode === "text") {
        return new Response('{"sub":"alice"}', {
          headers: { "content-type": "text/plain" },
        });
      }
      return new Response(
        await sign(
          {
            iss: OP,
            aud: "app",
            sub: "alice",
            iat: seconds(time.now),
            exp: seconds(time.now) + 60,
          },
          op.keys[0].privateKey,
          { alg: op.keys[0].alg, kid: op.keys[0].kid },
        ),
        { headers: { "content-type": "application/jwt" } },
      );
    },
  });
  for (const registered of [true, false]) {
    const client = new OidcClient({
      issuer: OP,
      metadata,
      client: { clientId: "app", method: "none" },
      redirectUri: CALLBACK,
      fetch,
      now: time.now,
      ...(registered ? { userinfoSignedResponseAlg: "ES256" as const } : {}),
    });
    const pending = await client.authorizationUrl();
    const answer = await op.handle(new Request(pending.authorization.url));
    const login = await client.completeLogin(
      pending,
      answer.headers.get("location")!,
    );
    mode = "signed";
    if (registered) {
      assertEquals((await client.userinfo(login.tokens, "alice")).sub, "alice");
    } else {await rejects(() => client.userinfo(login.tokens, "alice"), {
        code: "signature",
      });}
    mode = "text";
    await rejects(() => client.userinfo(login.tokens, "alice"), {
      kind: "token",
    });
    mode = "json";
    if (registered) {
      await rejects(() => client.userinfo(login.tokens, "alice"), {
        kind: "token",
      });
    }
  }
});

// Review F14: OpenID Connect Core section 5.3.2 asks a signed UserInfo
// answer for iss, aud and sub, not exp; a present exp still counts.
Deno.test("signed UserInfo needs no exp, and every other check still holds", async () => {
  const { op, time } = await setup();
  const metadata = {
    ...op.provider.metadata(),
    userinfo_signing_alg_values_supported: ["ES256"],
  };
  const stranger = await generateKeyPair("ES256", { kid: op.keys[0].kid });
  const es384 = await generateKeyPair("ES384", { kid: op.keys[0].kid });
  let answer: {
    claims: Record<string, unknown>;
    key?: CryptoKey;
    alg?: string;
  } = { claims: {} };
  const fetch = routeFetch({
    [OP]: async (request) => {
      if (new URL(request.url).pathname !== "/userinfo") {
        return await op.handle(request);
      }
      const claims = {
        iss: OP,
        aud: "app",
        sub: "alice",
        name: "Ada",
        ...answer.claims,
      };
      for (const [name, value] of Object.entries(claims)) {
        if (value === undefined) delete claims[name as keyof typeof claims];
      }
      return new Response(
        await sign(claims, answer.key ?? op.keys[0].privateKey, {
          alg: (answer.alg ?? op.keys[0].alg) as "ES256",
          kid: op.keys[0].kid,
          typ: "JWT",
        }),
        { headers: { "content-type": "application/jwt" } },
      );
    },
  });
  const client = new OidcClient({
    issuer: OP,
    metadata,
    client: { clientId: "app", method: "none" },
    redirectUri: CALLBACK,
    fetch,
    now: time.now,
    userinfoSignedResponseAlg: "ES256",
  });
  const pending = await client.authorizationUrl();
  const redirect = await op.handle(new Request(pending.authorization.url));
  const login = await client.completeLogin(
    pending,
    redirect.headers.get("location")!,
  );
  answer = { claims: {} };
  assertEquals((await client.userinfo(login.tokens, "alice")).name, "Ada");
  answer = { claims: { exp: seconds(time.now) + 60 } };
  assertEquals((await client.userinfo(login.tokens, "alice")).name, "Ada");
  const refused: [string, typeof answer, string][] = [
    [
      "an exp in the past",
      { claims: { exp: seconds(time.now) - 60 } },
      "signature",
    ],
    ["another issuer", { claims: { iss: "https://evil.test" } }, "signature"],
    ["another audience", { claims: { aud: "other" } }, "signature"],
    ["no issuer", { claims: { iss: undefined } }, "signature"],
    ["no audience", { claims: { aud: undefined } }, "signature"],
    ["another subject", { claims: { sub: "mallory" } }, "sub"],
    ["no subject", { claims: { sub: undefined } }, "sub"],
    ["another key", { claims: {}, key: stranger.privateKey }, "signature"],
    [
      "another algorithm",
      { claims: {}, key: es384.privateKey, alg: "ES384" },
      "signature",
    ],
  ];
  for (const [what, next, code] of refused) {
    answer = next;
    await rejects(() => client.userinfo(login.tokens, "alice"), { code })
      .catch((error) => {
        throw new Error(`${what}: ${error.message}`);
      });
  }
});

Deno.test("DB-OIDC-021: both standardized Ed25519 JOSE names round-trip provider and federation readiness", async () => {
  for (const alg of ["EdDSA", "Ed25519"] as const) {
    const time = clock(), key = await generateSigningKey(alg, alg);
    const op = await testProvider({
      issuer: OP,
      keys: [key],
      now: time.now,
      clients: [{ client_id: "app", redirect_uris: [CALLBACK] }],
    });
    await op.provider.ready();
    const client = new OidcClient({
      issuer: OP,
      metadata: op.provider.metadata(),
      client: { clientId: "app", method: "none" },
      redirectUri: CALLBACK,
      fetch: routeFetch({ [OP]: op.handle }),
      now: time.now,
    });
    await client.ready();
    const pending = await client.authorizationUrl(),
      response = await op.handle(new Request(pending.authorization.url));
    assertEquals(
      decode(
        (await client.completeLogin(pending, response.headers.get("location")!))
          .idToken,
      ).header.alg,
      alg,
    );
    const entity = new FederationEntity({
      entityId: OP,
      keys: [key],
      now: time.now,
    });
    await entity.ready();
    const resolver = new TrustChainResolver({
      trustAnchors: [{ entityId: OP, jwks: entity.jwks }],
      now: time.now,
      fetch: routeFetch({
        [OP]: async (request) => (await entity.handle(request))!,
      }),
    });
    assertEquals((await resolver.resolve(OP)).claims[0].sub, OP);
  }
});

// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * Regressions for the wave-4 sweep (WP-13) against `@celld/sec/oidc`: live
 * configuration, published keys, error text, logout redirects, the
 * broker's authentication time and record ownership, and the federated
 * provider's issuer. Each is named by its `DB-SWP` identifier and failed
 * on the code before it.
 *
 * @module
 */

import { assert, assertEquals } from "@celld/core/assert";
import { decode, generateKeyPair } from "@celld/sec/jwt";
import { OAuthError } from "@celld/sec/oauth";
import type { ClientAuthentication } from "@celld/sec/oauth/client";
import {
  generateSigningKey,
  unsafeMemoryRecordStore,
} from "@celld/sec/oauth/server";
import { routeFetch } from "@celld/sec/oauth/testing";
import { encryptedSecretStore, UpstreamBroker } from "@celld/sec/oidc/broker";
import {
  ExplicitRegistration,
  federatedOidcClient,
  FederationEntity,
  TrustChainResolver,
} from "@celld/sec/oidc/federation";
import type { OpenIdProvider } from "@celld/sec/oidc/provider";
import { CookieSealer, LoginFlow, OidcClient } from "@celld/sec/oidc/rp";
import { testBrowser, testProvider } from "@celld/sec/oidc/testing";
import { handlers, node, rebuild } from "./federation_fixture.ts";
import { clock, rejects, seconds } from "./fixture.ts";

const OP = "https://op.test";
const APP = "https://app.test";
const CALLBACK = `${APP}/callback`;
const SEALER_SECRET = "the-sweep-cookie-sealer-secret-0123456789";

// deno-lint-ignore no-explicit-any
const loose = (value: unknown): any => value;

// ----- DB-SWP-F15-13.D1: relying party, login flow and broker -----

Deno.test("DB-SWP-F15-13.D1: relying party options are read once", async () => {
  const op = await testProvider({
    issuer: OP,
    clients: [{ client_id: "app", redirect_uris: [CALLBACK] }],
  });
  const reached: string[] = [];
  const options = {
    issuer: "http://127.0.0.1:9",
    client: { method: "none", clientId: "app" } as ClientAuthentication,
    redirectUri: CALLBACK,
    fetch: (input: string | URL | Request) => {
      reached.push(String(input));
      return Promise.resolve(new Response("{}"));
    },
  };
  const loopback = new OidcClient(options);
  loose(options).allowLoopbackForDevelopment = true;
  await rejects(() => loopback.metadata(), { name: "OAuthError" });
  assertEquals(
    reached,
    [],
    "the development override cannot be turned on later",
  );
  const rp = new OidcClient({
    issuer: OP,
    metadata: op.provider.metadata(),
    client: { method: "none", clientId: "app" } as ClientAuthentication,
    redirectUri: CALLBACK,
    fetch: routeFetch({ [OP]: op.handle }),
  });
  const sealer = await CookieSealer.create({ secret: SEALER_SECRET });
  const flowOptions = { client: rp, sealer };
  const flow = new LoginFlow(flowOptions);
  loose(flowOptions).secure = false;
  const started = await flow.start(new Request(CALLBACK));
  assert(
    /;\s*Secure/i.test(started.headers.get("set-cookie") ?? ""),
    "the login cookie stays Secure",
  );
  const brokerOptions = {
    upstream: rp,
    sealer,
    secrets: await encryptedSecretStore(unsafeMemoryRecordStore(), {
      secret: SEALER_SECRET,
    }),
  };
  const broker = new UpstreamBroker(brokerOptions);
  loose(brokerOptions).secure = false;
  const begun = await broker.begin("interaction-1", new Request(CALLBACK));
  assert(
    /;\s*Secure/i.test(begun.headers.get("set-cookie") ?? ""),
    "the broker cookie stays Secure",
  );
});

// ----- DB-SWP-F15-13.D2: provider options -----

Deno.test("DB-SWP-F15-13.D2: provider keys and switches are read once", async () => {
  const time = clock();
  const first = await generateSigningKey("ES256", "first");
  const keys = [first];
  const options = {
    issuer: OP,
    keys,
    now: time.now,
    clients: [{ client_id: "app", redirect_uris: [CALLBACK] }],
  };
  const op = await testProvider(options);
  keys.unshift(await generateSigningKey("ES256", "second"));
  loose(options).requestObjects = true;
  const fetch = routeFetch({ [OP]: op.handle });
  const rp = new OidcClient({
    issuer: OP,
    client: { method: "none", clientId: "app" } as ClientAuthentication,
    redirectUri: CALLBACK,
    fetch,
    now: time.now,
  });
  const pending = await rp.authorizationUrl();
  const callback = await testBrowser(fetch).navigate(
    pending.authorization.url,
    CALLBACK,
  );
  const done = await rp.completeLogin(pending, callback);
  assertEquals(decode(done.tokens.id_token!).header.kid, "first");
  assertEquals(op.provider.metadata().request_parameter_supported, false);
});

// ----- DB-SWP-F15-13.D3 / DB-SWP-F11-13.D1: federation entity keys -----

Deno.test("DB-SWP-F11-13.D1: a federation entity publishes only minted keys and public JWKs", async () => {
  const key = await generateSigningKey("ES256", "fed");
  const entityId = "https://entity.test";
  let threw = false;
  try {
    new FederationEntity({ entityId, keys: [{ ...key }] });
  } catch (error) {
    threw = error instanceof TypeError;
  }
  assert(threw, "a copied key is not a signing key");
  const pair = await generateKeyPair("ES256", {
    kid: "leaf",
    extractable: true,
  });
  const privateJwk = await crypto.subtle.exportKey("jwk", pair.privateKey);
  for (
    const bad of [
      { ...privateJwk, kid: "leaf" },
      { kty: "oct", k: "c2VjcmV0", kid: "hmac" },
    ]
  ) {
    threw = false;
    try {
      new FederationEntity({
        entityId,
        keys: [key],
        subordinates: {
          "https://leaf.test": { jwks: { keys: [bad as never] } },
        },
      });
    } catch (error) {
      threw = error instanceof TypeError;
    }
    assert(threw, `a subordinate key with private members: ${bad.kty}`);
  }
});

Deno.test("DB-SWP-F15-13.D3: a federation entity is configured when it is made", async () => {
  const key = await generateSigningKey("ES256", "fed");
  const keys = [key];
  const leaf = await node("https://leaf.test");
  const subordinates: Record<string, { jwks: typeof leaf.jwks }> = {
    "https://leaf.test": { jwks: leaf.jwks },
  };
  const entity = new FederationEntity({
    entityId: "https://ta.test",
    keys,
    subordinates,
  });
  keys.unshift(await generateSigningKey("ES256", "intruder"));
  subordinates["https://evil.test"] = { jwks: leaf.jwks };
  const configuration = await entity.handle(
    new Request("https://ta.test/.well-known/openid-federation"),
  );
  assertEquals(decode(await configuration!.text()).header.kid, "fed");
  const fetched = await entity.handle(
    new Request("https://ta.test/federation_fetch?sub=https%3A%2F%2Fevil.test"),
  );
  assertEquals(fetched!.status, 404);
});

// ----- DB-SWP-F15-13.D4: the resolver's anchors and limits -----

Deno.test("DB-SWP-F15-13.D4: trust anchors and limits are read once", async () => {
  const time = clock();
  const ta = await node("https://ta.test", { now: time.now });
  const leaf = await node("https://leaf.test", {
    now: time.now,
    authorityHints: ["https://ta.test"],
  });
  const fake = await node("https://ta.test", { now: time.now });
  rebuild(fake, {
    now: time.now,
    subordinates: { "https://leaf.test": { jwks: leaf.jwks } },
  });
  const fetch = routeFetch(handlers([fake, leaf]));
  const control = new TrustChainResolver({
    trustAnchors: [{ entityId: "https://ta.test", jwks: fake.jwks }],
    fetch,
    now: time.now,
  });
  await control.resolve("https://leaf.test");
  const anchor = {
    entityId: "https://ta.test",
    jwks: { keys: [...ta.jwks.keys] },
  };
  const options = {
    trustAnchors: [anchor],
    fetch,
    now: time.now,
    maxFetches: 8,
  };
  const resolver = new TrustChainResolver(options);
  anchor.jwks.keys.push(...fake.jwks.keys);
  loose(options).maxFetches = 1_000_000;
  await rejects(() => resolver.resolve("https://leaf.test"), {
    name: "FederationError",
  });
  assertEquals(resolver.budget().fetches, 8);
});

// ----- DB-SWP-F16-13.D1: post-logout redirect URIs -----

Deno.test("DB-SWP-F16-13.D1: post-logout redirect URIs follow the redirect URI rule", async () => {
  for (const uri of ["http://evil.test/", "javascript:alert(1)"]) {
    let threw = false;
    try {
      await testProvider({
        issuer: OP,
        clients: [{
          client_id: "app",
          redirect_uris: [CALLBACK],
          post_logout_redirect_uris: [uri],
        }],
      });
    } catch (error) {
      threw = error instanceof TypeError;
    }
    assert(threw, `a configured ${uri} is refused`);
  }
  const op = await testProvider({ issuer: OP, registration: {} });
  for (const uri of ["http://evil.test/", "javascript:alert(1)"]) {
    const answer = await op.handle(
      new Request(`${OP}/register`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          redirect_uris: [CALLBACK],
          post_logout_redirect_uris: [uri],
          token_endpoint_auth_method: "none",
        }),
      }),
    );
    assertEquals(answer.status, 400, `registering ${uri}`);
  }
  await op.store.put("client:stored", {
    client_id: "stored",
    redirect_uris: [CALLBACK],
    grant_types: ["authorization_code"],
    token_endpoint_auth_method: "none",
    post_logout_redirect_uris: ["not a url"],
  }, null);
  const ended = await op.handle(
    new Request(
      `${OP}/end_session?client_id=stored&post_logout_redirect_uri=not%20a%20url`,
    ),
  );
  assertEquals(ended.status, 400);
});

// ----- DB-SWP-F4-13.D1 / DB-SWP-F5-13.D1: the broker -----

const UPSTREAM_A = "https://upstream-a.test";
const UPSTREAM_B = "https://upstream-b.test";

function fakeUpstream(issuer: string, claims: Record<string, unknown>) {
  return {
    issuer,
    unsafeRestoreGrant: (value: unknown) => Promise.resolve(value),
    unsafeRestorePendingLogin: (value: unknown) => Promise.resolve(value),
    authorizationUrl: () =>
      Promise.resolve({
        authorization: { url: `${issuer}/authorize`, state: "s" },
      }),
    completeLogin: () =>
      Promise.resolve({
        tokens: {
          access_token: `${issuer}-access`,
          token_type: "Bearer",
          refresh_token: `${issuer}-refresh`,
        },
        claims,
        subject: claims.sub,
      }),
    metadata: () => Promise.resolve({}),
  } as unknown as OidcClient;
}

async function brokered(
  upstream: OidcClient,
  secrets: Awaited<ReturnType<typeof encryptedSecretStore>>,
) {
  const sealer = await CookieSealer.create({ secret: SEALER_SECRET });
  const broker = new UpstreamBroker({ upstream, sealer, secrets });
  const begun = await broker.begin("interaction-1", new Request(CALLBACK));
  const cookie = begun.headers.get("set-cookie")!.split(";")[0];
  const seen: unknown[] = [];
  const provider = {
    resumeAuthorization: (_id: string, decision: unknown) => {
      seen.push(decision);
      return Promise.resolve(new Response(null, { status: 303 }));
    },
  } as unknown as OpenIdProvider;
  await broker.finish(
    provider,
    new Request("https://broker.test/callback?code=c&state=s", {
      headers: { cookie },
    }),
  );
  return { broker, seen };
}

Deno.test("DB-SWP-F4-13.D1: the broker never invents an authentication time", async () => {
  const time = clock();
  const secrets = await encryptedSecretStore(unsafeMemoryRecordStore(), {
    secret: SEALER_SECRET,
  });
  const { seen } = await brokered(
    fakeUpstream(UPSTREAM_A, {
      iss: UPSTREAM_A,
      sub: "alice",
      aud: "broker",
      iat: seconds(time.now),
      exp: seconds(time.now) + 600,
    }),
    secrets,
  );
  const decision = seen[0] as { grant: { authTime?: number } };
  assertEquals(decision.grant.authTime, undefined);
});

Deno.test("DB-SWP-F5-13.D1: brokers sharing a store never read each other's users", async () => {
  const time = clock();
  const secrets = await encryptedSecretStore(unsafeMemoryRecordStore(), {
    secret: SEALER_SECRET,
  });
  const claims = (issuer: string) => ({
    iss: issuer,
    sub: "alice",
    aud: "broker",
    iat: seconds(time.now),
    exp: seconds(time.now) + 600,
  });
  const a = await brokered(
    fakeUpstream(UPSTREAM_A, claims(UPSTREAM_A)),
    secrets,
  );
  const sealer = await CookieSealer.create({ secret: SEALER_SECRET });
  const b = new UpstreamBroker({
    upstream: fakeUpstream(UPSTREAM_B, claims(UPSTREAM_B)),
    sealer,
    secrets,
  });
  assertEquals(await b.record("alice"), null);
  assertEquals(await b.upstreamTokens("alice"), null);
  assertEquals(
    (await a.broker.upstreamTokens("alice"))?.access_token,
    `${UPSTREAM_A}-access`,
  );
  assert(
    (await secrets.get(await secrets.identityKey(UPSTREAM_A, "alice"))) !==
      null,
    "records are keyed by upstream issuer and subject",
  );
});

// ----- DB-SWP-F5-13.D2: a federated provider's issuer is its entity id -----

Deno.test("DB-SWP-F5-13.D2: a federated provider must be the issuer it names", async () => {
  const time = clock();
  const now = time.now;
  const TA = "https://ta.test";
  const PROVIDER = "https://idp.test";
  const RP = "https://rp.test";
  const ta = await node(TA, { now });
  const rpKey = await generateSigningKey("ES256", "rp-key");
  const idp = await node(PROVIDER, {
    now,
    authorityHints: [TA],
    metadata: {
      openid_provider: {
        issuer: "https://other-idp.test",
        authorization_endpoint: "https://other-idp.test/authorize",
        token_endpoint: "https://other-idp.test/token",
        pushed_authorization_request_endpoint: "https://other-idp.test/par",
        jwks_uri: "https://other-idp.test/jwks",
        response_types_supported: ["code"],
        subject_types_supported: ["public"],
        id_token_signing_alg_values_supported: ["ES256"],
        code_challenge_methods_supported: ["S256"],
      },
    },
  });
  const rp = await node(RP, {
    now,
    authorityHints: [TA],
    metadata: {
      openid_relying_party: {
        redirect_uris: [`${RP}/callback`],
        jwks: { keys: [{ ...rpKey.publicJwk, kid: rpKey.kid }] },
        token_endpoint_auth_method: "private_key_jwt",
      },
    },
  });
  rebuild(ta, {
    now,
    subordinates: {
      [PROVIDER]: { jwks: idp.jwks },
      [RP]: { jwks: rp.jwks },
    },
  });
  const resolver = new TrustChainResolver({
    trustAnchors: [{ entityId: TA, jwks: ta.jwks }],
    fetch: routeFetch(handlers([ta, idp, rp])),
    now,
  });
  const error = await rejects(
    () =>
      federatedOidcClient({
        resolver,
        provider: PROVIDER,
        relyingParty: RP,
        key: rpKey,
        redirectUri: `${RP}/callback`,
        now,
      }),
    { kind: "discovery" },
  );
  assert(error instanceof OAuthError, "an OAuthError");
});

// ----- Follow-up sweep (WP-13b): findings filed to WP-13 for oidc -----

Deno.test("DB-SWP-F1-13b.D1: end_session reads its form under a cap", async () => {
  const op = await testProvider({ issuer: OP });
  const answer = await op.handle(
    new Request(`${OP}/end_session`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: `state=${"a".repeat(17 * 1024)}`,
    }),
  );
  assertEquals(answer.status, 413);
});

Deno.test("DB-SWP-F1-13b.D2: explicit registration reads its statement under a cap", async () => {
  const registration = new ExplicitRegistration({
    resolver: {} as never,
    entity: { entityId: OP } as never,
    store: unsafeMemoryRecordStore(),
  });
  const answer = await registration.handle(
    new Request(`${OP}/federation_registration`, {
      method: "POST",
      headers: { "content-type": "application/entity-statement+jwt" },
      body: "a".repeat(300 * 1024),
    }),
  );
  assertEquals(answer.status, 413);
});

Deno.test("DB-SWP-F1-13b.D3: UserInfo answers are read under a cap", async () => {
  const op = await testProvider({ issuer: OP });
  const metadata = op.provider.metadata();
  const rp = new OidcClient({
    issuer: OP,
    metadata,
    client: { method: "none", clientId: "app" } as ClientAuthentication,
    redirectUri: CALLBACK,
    fetch: routeFetch({
      [OP]: (request) =>
        new URL(request.url).pathname === "/userinfo"
          ? Response.json({ sub: "user-1", pad: "x".repeat(2 * 1024 * 1024) })
          : op.handle(request),
    }),
  });
  await rejects(
    async () =>
      rp.userinfo(
        await rp.unsafeRestoreGrant({
          access_token: "t",
          token_type: "Bearer",
          provenance: {
            issuer: OP,
            clientId: "app",
            resources: [],
            requestedScopes: ["openid"],
            grantedScopes: ["openid"],
            grantType: "authorization_code",
            acquiredAt: Date.now(),
            generation: "test-generation",
          },
        }),
        "user-1",
      ),
    { name: "OAuthError", kind: "token" },
  );
});

Deno.test("DB-SWP-F9-13b.D1: the test provider's users are looked up as own keys", async () => {
  const op = await testProvider({
    issuer: OP,
    clients: [{ client_id: "app", redirect_uris: [CALLBACK] }],
    consent: () => ({
      grant: {
        subject: "constructor",
        authTime: Math.floor(Date.now() / 1000),
      },
    }),
  });
  const fetch = routeFetch({ [OP]: op.handle });
  const rp = new OidcClient({
    issuer: OP,
    metadata: op.provider.metadata(),
    client: { method: "none", clientId: "app" } as ClientAuthentication,
    redirectUri: CALLBACK,
    fetch,
  });
  const pending = await rp.authorizationUrl({ scope: ["openid", "profile"] });
  const login = await rp.completeLogin(
    pending,
    await testBrowser(fetch).navigate(pending.authorization.url, CALLBACK),
  );
  // Not `name: "Object"`, from Object.prototype.constructor.
  assertEquals(await rp.userinfo(login.tokens, "constructor"), {
    sub: "constructor",
  });
});

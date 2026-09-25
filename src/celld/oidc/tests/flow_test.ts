// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * Federated logins end to end, in one process: a trust anchor, an
 * upstream OpenID Provider, a broker that is both a relying party of the
 * upstream and a provider of its own, and an app that logs in at the
 * broker. Every party finds the others through trust chains, registers
 * automatically, and holds its own DPoP key.
 *
 * @module
 */

import { assert, assertEquals } from "@celld/assert";
import { decode } from "@celld/jwt";
import { boundTokenExchange, UpstreamBroker } from "@celld/oidc/broker";
import {
  ExplicitRegistration,
  federatedClients,
  federatedOidcClient,
  type FederationEntityOptions,
  MEDIA_TYPES,
  signStatement,
  TrustChainResolver,
  verifyStatement,
} from "@celld/oidc/federation";
import { OpenIdProvider } from "@celld/oidc/provider";
import { CookieSealer, OidcClient } from "@celld/oidc/rp";
import { testBrowser } from "@celld/oidc/testing";
import { TOKEN_TYPES } from "@celld/oauth";
import { OAuthClient } from "@celld/oauth/client";
import { DpopKey } from "@celld/oauth/dpop";
import {
  generateSigningKey,
  memoryRecordStore,
  type SigningKey,
} from "@celld/oauth/server";
import { clock, rejects, seconds } from "./fixture.ts";
import { handlers, type Node, node, rebuild } from "./federation_fixture.ts";

const TA = "https://ta.test";
const UP = "https://upstream.test";
const BROKER = "https://broker.test";
const APP = "https://app.test";
const API = "https://api.test";
const STRANGER = "https://stranger.test";

function rpMetadata(id: string, key: SigningKey, callback: string) {
  return {
    redirect_uris: [callback],
    jwks: { keys: [{ ...key.publicJwk, kid: key.kid, alg: key.alg }] },
    token_endpoint_auth_method: "private_key_jwt",
    token_endpoint_auth_signing_alg: key.alg,
    grant_types: [
      "authorization_code",
      "refresh_token",
      "urn:ietf:params:oauth:grant-type:token-exchange",
    ],
    response_types: ["code"],
    client_registration_types: ["automatic"],
    client_name: new URL(id).hostname,
    post_logout_redirect_uris: [`${id}/`],
  };
}

async function world() {
  const time = clock();
  const now = time.now;
  const ta = await node(TA, { now });
  const up = await node(UP, { now });
  const broker = await node(BROKER, { now });
  const app = await node(APP, { now });
  const stranger = await node(STRANGER, { now });
  const upKey = await generateSigningKey("ES256", "upstream-oidc");
  const brokerKey = await generateSigningKey("ES256", "broker-oidc");
  const brokerRpKey = await generateSigningKey("ES256", "broker-rp");
  const appRpKey = await generateSigningKey("ES256", "app-rp");
  const brokerDpop = await DpopKey.generate({ now });
  const appDpop = await DpopKey.generate({ now });
  const policy = {
    openid_relying_party: {
      dpop_bound_access_tokens: { value: true },
      token_endpoint_auth_method: { one_of: ["private_key_jwt"] },
    },
    openid_provider: {
      dpop_signing_alg_values_supported: { subset_of: ["ES256"] },
    },
  };
  rebuild(ta, {
    now,
    subordinates: {
      [UP]: { jwks: up.jwks, metadataPolicy: policy },
      [BROKER]: { jwks: broker.jwks, metadataPolicy: policy },
      [APP]: { jwks: app.jwks, metadataPolicy: policy },
      [STRANGER]: { jwks: stranger.jwks, metadataPolicy: policy },
    },
  });
  const extra: Record<string, (request: Request) => Promise<Response>> = {};
  const requests: Request[] = [];
  const fetch = Object.assign(
    async (input: string | URL | Request, init?: RequestInit) => {
      const request = new Request(input, init);
      requests.push(request.clone());
      const table = { ...handlers([ta, up, broker, app, stranger]), ...extra };
      const handler = table[new URL(request.url).origin];
      if (handler === undefined) {
        throw new TypeError(`no route for ${request.url}`);
      }
      return await handler(request);
    },
    { requests },
  );
  const resolver = (through: typeof fetch) =>
    new TrustChainResolver({
      trustAnchors: [{ entityId: TA, jwks: ta.jwks }],
      fetch: through,
      now,
    });

  // The upstream provider: automatic and explicit registration.
  const upStore = memoryRecordStore({ now });
  const upResolver = resolver(fetch);
  const upstream = new OpenIdProvider({
    issuer: UP,
    keys: [upKey],
    store: upStore,
    now,
    fetch,
    resolveClient: federatedClients({ resolver: upResolver, now }),
    interaction: () => ({
      grant: {
        subject: "alice",
        authTime: seconds(now),
        acr: "urn:upstream:pwd",
        amr: ["pwd"],
      },
    }),
    claims: () => ({
      email: "alice@upstream.test",
      email_verified: true,
      name: "Alice",
    }),
  });
  const upOptions: Omit<FederationEntityOptions, "entityId" | "keys"> = {
    now,
    authorityHints: [TA],
    metadata: () => ({
      openid_provider: {
        ...upstream.metadata(),
        client_registration_types_supported: ["automatic", "explicit"],
        federation_registration_endpoint: `${UP}/federation_registration`,
      },
    }),
  };
  rebuild(up, upOptions);
  const registration = new ExplicitRegistration({
    resolver: upResolver,
    entity: up.entity,
    store: upStore,
    now,
  });
  extra[UP] = async (request) => {
    if (new URL(request.url).pathname === "/federation_registration") {
      return await registration.handle(request);
    }
    return await up.entity.handle(request) ?? await upstream.handle(request) ??
      new Response("not found", { status: 404 });
  };

  // The broker: an RP of the upstream, and a provider for the app.
  const brokerStore = memoryRecordStore({ now });
  const sealer = await CookieSealer.create({
    secret: "the-broker-cookie-secret-0123456789",
    now,
  });
  const brokerOp = new OpenIdProvider({
    issuer: BROKER,
    keys: [brokerKey],
    store: brokerStore,
    now,
    fetch,
    resolveClient: federatedClients({ resolver: resolver(fetch), now }),
    resources: { allowed: [API] },
    tokenExchange: boundTokenExchange(),
    interaction: (context) => upstreamBroker.begin(context.interactionId),
    claims: ({ subject, claims }) => upstreamBroker.claims(subject, claims),
  });
  let upstreamBroker: UpstreamBroker;
  rebuild(broker, {
    now,
    authorityHints: [TA],
    metadata: () => ({
      openid_provider: {
        ...brokerOp.metadata(),
        client_registration_types_supported: ["automatic"],
      },
      openid_relying_party: rpMetadata(
        BROKER,
        brokerRpKey,
        `${BROKER}/upstream/callback`,
      ),
    }),
  });
  rebuild(app, {
    now,
    authorityHints: [TA],
    metadata: {
      openid_relying_party: rpMetadata(APP, appRpKey, `${APP}/callback`),
    },
  });
  rebuild(stranger, {
    now,
    authorityHints: [TA],
    metadata: {
      openid_relying_party: rpMetadata(
        STRANGER,
        appRpKey,
        `${STRANGER}/callback`,
      ),
    },
  });
  const setupBroker = async () => {
    const federated = await federatedOidcClient({
      resolver: resolver(fetch),
      provider: UP,
      relyingParty: BROKER,
      key: brokerRpKey,
      redirectUri: `${BROKER}/upstream/callback`,
      dpop: brokerDpop,
      fetch,
      now,
    });
    upstreamBroker = new UpstreamBroker({
      upstream: federated.client,
      sealer,
      store: brokerStore,
      secure: false,
      subject: (claims) => `upstream:${claims.sub}`,
      now,
    });
    return federated;
  };
  extra[BROKER] = async (request) => {
    if (new URL(request.url).pathname === "/upstream/callback") {
      return await upstreamBroker.finish(brokerOp, request, {
        sessionId: "broker-session",
      });
    }
    return await broker.entity.handle(request) ??
      await brokerOp.handle(request) ??
      new Response("not found", { status: 404 });
  };
  return {
    time,
    fetch,
    resolver: () => resolver(fetch),
    setupBroker,
    broker: () => upstreamBroker,
    brokerOp,
    upstream,
    upStore,
    brokerDpop,
    appDpop,
    appRpKey,
    nodes: { ta, up, broker, app, stranger } as Record<string, Node>,
  };
}

Deno.test("the federation's policy limits the providers' DPoP algorithms and binds every RP", async () => {
  const w = await world();
  const own = w.upstream.metadata().dpop_signing_alg_values_supported;
  assert((own ?? []).includes("RS256"), "the upstream offers more on its own");
  const chain = await w.resolver().resolve(UP);
  assertEquals(
    chain.metadata.openid_provider.dpop_signing_alg_values_supported,
    ["ES256"],
  );
  const app = await w.resolver().resolve(APP);
  assertEquals(
    app.metadata.openid_relying_party.dpop_bound_access_tokens,
    true,
  );
});

Deno.test("a federated login through a broker, DPoP-bound at every hop", async () => {
  const w = await world();
  const upstreamClient = await w.setupBroker();
  assertEquals(upstreamClient.dpop, true);
  const app = await federatedOidcClient({
    resolver: w.resolver(),
    provider: BROKER,
    relyingParty: APP,
    key: w.appRpKey,
    redirectUri: `${APP}/callback`,
    dpop: w.appDpop,
    fetch: w.fetch,
    now: w.time.now,
  });
  assertEquals(app.dpop, true);
  assertEquals(app.provider.dpop_signing_alg_values_supported, ["ES256"]);
  const pending = await app.client.authorizationUrl({
    scope: ["email", "profile"],
  });
  const par = w.fetch.requests.find((request) =>
    request.url === `${BROKER}/par`
  )!;
  assert(par.headers.has("dpop"), "the app's PAR carries its proof");
  const form = new URLSearchParams(await par.text());
  assertEquals(form.get("client_id"), APP);
  assertEquals(form.get("dpop_jkt"), w.appDpop.jkt);
  assertEquals(decode(form.get("client_assertion")!).payload.aud, BROKER);

  const browser = testBrowser(w.fetch);
  const callback = await browser.navigate(
    pending.authorization.url,
    `${APP}/callback`,
  );
  const login = await app.client.completeLogin(pending, callback);

  // Downstream: the app's tokens are bound to the app's key.
  assertEquals(login.tokens.token_type, "DPoP");
  const downstream = decode(login.tokens.access_token).payload;
  assertEquals(downstream.iss, BROKER);
  assertEquals(downstream.client_id, APP);
  assertEquals((downstream.cnf as { jkt: string }).jkt, w.appDpop.jkt);
  assertEquals(login.claims.iss, BROKER);
  assertEquals(login.subject, "upstream:alice");
  assertEquals(login.claims.acr, "urn:upstream:pwd");
  assertEquals(login.claims.amr, ["pwd"]);

  // Upstream: the broker's tokens are bound to the broker's key, and stay with it.
  const record = await w.broker().record("upstream:alice");
  assertEquals(record?.tokens.token_type, "DPoP");
  const upstreamToken = decode(record!.tokens.access_token).payload;
  assertEquals(upstreamToken.iss, UP);
  assertEquals(upstreamToken.client_id, BROKER);
  assertEquals((upstreamToken.cnf as { jkt: string }).jkt, w.brokerDpop.jkt);
  const upstreamUserinfo = w.fetch.requests.filter((request) =>
    request.url === `${UP}/userinfo`
  );
  assertEquals(upstreamUserinfo.length, 1);
  assert(
    upstreamUserinfo[0].headers.get("authorization")!.startsWith("DPoP "),
    "the broker calls upstream UserInfo with DPoP",
  );
  assertEquals(
    decode(upstreamUserinfo[0].headers.get("dpop")!).header.jwk,
    w.brokerDpop.publicJwk,
  );

  // UserInfo at the broker, with the app's proof, answers upstream claims.
  const info = await app.client.userinfo(login.tokens, login.subject);
  assertEquals(info, {
    email: "alice@upstream.test",
    email_verified: true,
    name: "Alice",
    sub: "upstream:alice",
  });

  // The broker's own upstream token is useless at the broker's UserInfo, and vice versa.
  const crossed = await w.fetch(`${BROKER}/userinfo`, {
    headers: { authorization: `DPoP ${record!.tokens.access_token}` },
  });
  assertEquals(crossed.status, 401);
  const reversed = await w.fetch(`${UP}/userinfo`, {
    headers: { authorization: `DPoP ${login.tokens.access_token}` },
  });
  assertEquals(reversed.status, 401);

  // Token exchange keeps the binding: the same key, or nothing.
  const oauth = await app.client.oauth();
  const exchanged = await oauth.tokenExchange({
    subjectToken: login.tokens.access_token,
    subjectTokenType: TOKEN_TYPES.accessToken,
    resource: API,
    scope: ["email"],
  });
  assertEquals(exchanged.token_type, "DPoP");
  const claims = decode(exchanged.access_token).payload;
  assertEquals(claims.aud, API);
  assertEquals((claims.cnf as { jkt: string }).jkt, w.appDpop.jkt);
  const thief = new OAuthClient({
    issuer: BROKER,
    metadata: app.provider,
    client: {
      method: "private_key_jwt",
      clientId: APP,
      privateKey: w.appRpKey.privateKey,
      alg: "ES256",
      kid: w.appRpKey.kid,
    },
    dpop: await DpopKey.generate({ now: w.time.now }),
    fetch: w.fetch,
    now: w.time.now,
  });
  await rejects(
    () =>
      thief.tokenExchange({
        subjectToken: login.tokens.access_token,
        subjectTokenType: TOKEN_TYPES.accessToken,
        resource: API,
      }),
    { kind: "token", error: "invalid_grant" },
  );
  const bearer = new OAuthClient({
    issuer: BROKER,
    metadata: app.provider,
    client: {
      method: "private_key_jwt",
      clientId: APP,
      privateKey: w.appRpKey.privateKey,
      alg: "ES256",
      kid: w.appRpKey.kid,
    },
    fetch: w.fetch,
    now: w.time.now,
  });
  await rejects(
    () =>
      bearer.tokenExchange({
        subjectToken: login.tokens.access_token,
        subjectTokenType: TOKEN_TYPES.accessToken,
        resource: API,
      }),
    { kind: "token", error: "invalid_dpop_proof" },
  );
  await rejects(
    () =>
      oauth.tokenExchange({
        subjectToken: login.tokens.access_token,
        subjectTokenType: TOKEN_TYPES.accessToken,
        resource: API,
        scope: ["admin"],
      }),
    { kind: "token" },
  );

  // The broker calls the upstream as itself, with its own proof.
  const upstreamInfo = await w.broker().fetchUpstream(
    "upstream:alice",
    `${UP}/userinfo`,
  );
  assertEquals((await upstreamInfo.json()).sub, "alice");
});

Deno.test("automatic registration refuses what the federation does not vouch for", async () => {
  const w = await world();
  await rejects(
    () =>
      federatedOidcClient({
        resolver: w.resolver(),
        provider: BROKER,
        relyingParty: APP,
        key: w.appRpKey,
        redirectUri: `${APP}/callback`,
        fetch: w.fetch,
        now: w.time.now,
      }),
    { kind: "dpop" },
  );
  await rejects(
    async () =>
      federatedOidcClient({
        resolver: w.resolver(),
        provider: BROKER,
        relyingParty: APP,
        key: w.appRpKey,
        redirectUri: `${APP}/callback`,
        dpop: await DpopKey.generate({ alg: "PS256", now: w.time.now }),
        fetch: w.fetch,
        now: w.time.now,
      }),
    { kind: "dpop" },
  );
  const noDpop = new OidcClient({
    issuer: UP,
    metadata: (await w.resolver().resolve(UP)).metadata
      .openid_provider as never,
    client: {
      method: "private_key_jwt",
      clientId: APP,
      privateKey: w.appRpKey.privateKey,
      alg: "ES256",
      kid: w.appRpKey.kid,
    },
    redirectUri: `${APP}/callback`,
    fetch: w.fetch,
    now: w.time.now,
  });
  await rejects(() => noDpop.authorizationUrl(), {
    kind: "token",
    error: "invalid_dpop_proof",
  });
  const outsider = new OidcClient({
    issuer: UP,
    metadata: (await w.resolver().resolve(UP)).metadata
      .openid_provider as never,
    client: {
      method: "private_key_jwt",
      clientId: "https://outsider.test",
      privateKey: w.appRpKey.privateKey,
      alg: "ES256",
      kid: w.appRpKey.kid,
    },
    redirectUri: "https://outsider.test/callback",
    dpop: w.appDpop,
    fetch: w.fetch,
    now: w.time.now,
  });
  await rejects(() => outsider.authorizationUrl(), {
    kind: "token",
    error: "invalid_client",
  });
  const wrongKey = new OidcClient({
    issuer: UP,
    metadata: (await w.resolver().resolve(UP)).metadata
      .openid_provider as never,
    client: {
      method: "private_key_jwt",
      clientId: APP,
      privateKey: (await generateSigningKey("ES256", "app-rp")).privateKey,
      alg: "ES256",
      kid: "app-rp",
    },
    redirectUri: `${APP}/callback`,
    dpop: w.appDpop,
    fetch: w.fetch,
    now: w.time.now,
  });
  await rejects(() => wrongKey.authorizationUrl(), {
    kind: "token",
    error: "invalid_client",
  });
});

Deno.test("explicit registration: the RP posts its configuration and gets a registration", async () => {
  const w = await world();
  const configuration = async (claims: Record<string, unknown>) => {
    const iat = seconds(w.time.now);
    return await signStatement({
      iss: STRANGER,
      sub: STRANGER,
      iat,
      exp: iat + 3600,
      aud: UP,
      jwks: w.nodes.stranger.jwks,
      authority_hints: [TA],
      metadata: {
        openid_relying_party: {
          redirect_uris: [`${STRANGER}/callback`],
          jwks: {
            keys: [{
              ...w.appRpKey.publicJwk,
              kid: "stranger-rp",
              alg: "ES256",
            }],
          },
          token_endpoint_auth_method: "private_key_jwt",
          client_registration_types: ["explicit"],
        },
      },
      ...claims,
    }, w.nodes.stranger.key);
  };
  const post = async (
    body: string,
    type = "application/entity-statement+jwt",
  ) =>
    await w.fetch(`${UP}/federation_registration`, {
      method: "POST",
      headers: { "content-type": type },
      body,
    });
  const response = await post(await configuration({}));
  assertEquals(
    response.headers.get("content-type"),
    "application/explicit-registration-response+jwt",
  );
  const answer = await verifyStatement(await response.text(), w.nodes.up.jwks, {
    now: w.time.now,
    typ: MEDIA_TYPES.explicitRegistrationResponse,
    requireJwks: false,
  });
  assertEquals(answer.iss, UP);
  assertEquals(answer.aud, STRANGER);
  assertEquals(answer.trust_anchor, TA);
  assertEquals(answer.authority_hints, [TA]);
  const registered = answer.metadata!.openid_relying_party;
  assertEquals(registered.client_id, STRANGER);
  assertEquals(registered.dpop_bound_access_tokens, true, "the policy applied");
  const stored = await w.upStore.get<{ client_id: string }>(
    `client:${STRANGER}`,
  );
  assertEquals(stored?.value.client_id, STRANGER);
  assertEquals(stored?.expiresAt, answer.exp * 1000);

  assertEquals((await post(await configuration({ aud: BROKER }))).status, 400);
  assertEquals(
    (await post(await configuration({}), "application/json")).status,
    415,
  );
  const forged = await signStatement({
    iss: STRANGER,
    sub: STRANGER,
    iat: seconds(w.time.now),
    exp: seconds(w.time.now) + 60,
    aud: UP,
    jwks: w.nodes.app.jwks,
    authority_hints: [TA],
  }, w.nodes.app.key);
  const refused = await post(forged);
  assertEquals(refused.status, 400);
  assertEquals((await refused.json()).error, "invalid_trust_chain");
});

Deno.test("logging out at the broker ends the downstream session", async () => {
  const w = await world();
  await w.setupBroker();
  const app = await federatedOidcClient({
    resolver: w.resolver(),
    provider: BROKER,
    relyingParty: APP,
    key: w.appRpKey,
    redirectUri: `${APP}/callback`,
    dpop: w.appDpop,
    fetch: w.fetch,
    now: w.time.now,
  });
  const pending = await app.client.authorizationUrl();
  const browser = testBrowser(w.fetch);
  const login = await app.client.completeLogin(
    pending,
    await browser.navigate(pending.authorization.url, `${APP}/callback`),
  );
  const out = await w.fetch(
    await app.client.logoutUrl({
      idTokenHint: login.idToken,
      postLogoutRedirectUri: `${APP}/`,
      state: "s",
    }),
  );
  assertEquals(out.status, 303);
  assertEquals(out.headers.get("location"), `${APP}/?state=s`);
  await rejects(() => app.client.userinfo(login.tokens, login.subject), {
    error: "invalid_token",
  });
});

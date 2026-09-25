// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * Regressions for the Daybreak audit's OpenID Connect findings, one or
 * more tests per finding, each named after it.
 *
 * @module
 */

import { assert, assertEquals } from "@celld/core/assert";
import { decode, generateKeyPair, sign } from "@celld/sec/jwt";
import { discoverOpenIdProvider, tokenHash } from "@celld/sec/oidc";
import { type OidcDecision, OpenIdProvider } from "@celld/sec/oidc/provider";
import { type LoginOptions, OidcClient } from "@celld/sec/oidc/rp";
import {
  TEST_SESSION_SID_KEY,
  testBrowser,
  testProvider,
  type TestProviderOptions,
} from "@celld/sec/oidc/testing";
import type { ClientAuthentication } from "@celld/sec/oauth/client";
import {
  generateSigningKey,
  type RecordStore,
  unsafeMemoryRecordStore,
} from "@celld/sec/oauth/server";
import { routeFetch } from "@celld/sec/oauth/testing";
import { OAuthError } from "@celld/sec/oauth";
import type { TokenSet } from "@celld/sec/oauth/client";
import {
  brokerRecordKey,
  encryptedSecretStore,
  type SecretStore,
  UpstreamBroker,
  type UpstreamRecord,
} from "@celld/sec/oidc/broker";
import { CookieSealer } from "@celld/sec/oidc/rp";
import {
  checkStatementClaims,
  federatedClients,
  FederationEntity,
  FederationError,
  federationJwks,
  issueTrustMark,
  MEDIA_TYPES,
  signStatement,
  TrustChainResolver,
  type TrustChainResolverOptions,
  verifyStatement,
} from "@celld/sec/oidc/federation";
import { handlers, node, rebuild } from "./federation_fixture.ts";
import { clock, rejects, seconds } from "./fixture.ts";

const OP = "https://op.test";
const APP = "https://app.test";
const CALLBACK = `${APP}/callback`;
const CHALLENGE = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM";

async function setup(options: Partial<TestProviderOptions> = {}) {
  const time = clock();
  const signer = await generateKeyPair("ES256", { kid: "app-key" });
  const op = await testProvider({
    issuer: OP,
    now: time.now,
    clients: [
      {
        client_id: "app",
        redirect_uris: [CALLBACK],
        post_logout_redirect_uris: [`${APP}/bye`],
      },
      {
        client_id: "other",
        redirect_uris: [CALLBACK],
        post_logout_redirect_uris: [`${APP}/bye`],
      },
      {
        client_id: "signed-app",
        redirect_uris: [CALLBACK],
        jwks: { keys: [signer.publicJwk] },
        token_endpoint_auth_method: "private_key_jwt",
      },
    ],
    requestObjects: true,
    ...options,
  });
  const fetch = routeFetch({ [OP]: op.handle });
  const browser = testBrowser(fetch);
  const rp = (
    more: Partial<ConstructorParameters<typeof OidcClient>[0]> = {},
  ) =>
    new OidcClient({
      issuer: OP,
      client: { method: "none", clientId: "app" } as ClientAuthentication,
      redirectUri: CALLBACK,
      fetch,
      now: time.now,
      ...more,
    });
  const login = async (client: OidcClient, options: LoginOptions = {}) => {
    const pending = await client.authorizationUrl(options);
    const callback = await browser.navigate(
      pending.authorization.url,
      CALLBACK,
    );
    return { pending, callback };
  };
  const signIn = async (client: OidcClient, options: LoginOptions = {}) => {
    const { pending, callback } = await login(client, options);
    return await client.completeLogin(pending, callback);
  };
  return { time, op, fetch, browser, rp, login, signIn, signer };
}

/** A direct authorization request URL for `app` with these extra parameters. */
function authorizeUrl(extra: readonly [string, string][]): string {
  const url = new URL(`${OP}/authorize`);
  for (
    const [name, value] of [
      ["response_type", "code"],
      ["client_id", "app"],
      ["redirect_uri", CALLBACK],
      ["scope", "openid"],
      ["code_challenge", CHALLENGE],
      ["code_challenge_method", "S256"],
      ["state", "s"],
      ...extra,
    ]
  ) {
    url.searchParams.append(name, value);
  }
  return url.href;
}

// DB-OIDC-001: ID token hints.

Deno.test("DB-OIDC-001: an access token is refused as id_token_hint at authorize and end_session", async () => {
  const { rp, signIn, fetch } = await setup();
  const client = rp();
  const done = await signIn(client);
  assertEquals(decode(done.tokens.access_token).header.typ, "at+jwt");
  assert(
    decode(done.tokens.access_token).payload.sid !== undefined,
    "the access token carries the sid",
  );
  await rejects(
    () =>
      client.authorizationUrl({
        idTokenHint: done.tokens.access_token as never,
      }),
    { kind: "token" },
  );
  for (const extra of ["&client_id=app", ""]) {
    const response = await fetch(
      `${OP}/end_session?id_token_hint=${done.tokens.access_token}${extra}`,
    );
    assertEquals(response.status, 400, await response.text());
  }
  const info = await client.userinfo(done.tokens, "user-1");
  assertEquals(info.sub, "user-1", "the login session did not end");
});

Deno.test("DB-OIDC-001: a hint issued to another client is refused at authorize and end_session", async () => {
  const { rp, signIn, fetch, op, time } = await setup();
  const app = rp();
  const other = rp({
    client: { method: "none", clientId: "other" } as ClientAuthentication,
  });
  const theirs = await signIn(other);
  assertEquals(theirs.claims.aud, "other");
  await rejects(() => app.authorizationUrl({ idTokenHint: theirs.tokens }), {
    kind: "token",
  });
  const refused = await fetch(
    `${OP}/end_session?id_token_hint=${theirs.idToken}&client_id=app`,
  );
  assertEquals(refused.status, 400);
  // A genuine ID token for an audience that is no registered client ends
  // nothing, with or without client_id.
  const key = op.keys[0];
  const iat = seconds(time.now);
  const ghost = await sign(
    {
      iss: OP,
      sub: "user-1",
      aud: "ghost",
      iat,
      exp: iat + 600,
      sid: theirs.claims.sid,
      token_use: "id",
    },
    key.privateKey,
    { alg: key.alg, kid: key.kid, typ: "JWT" },
  );
  for (const extra of ["", "&client_id=ghost"]) {
    const response = await fetch(
      `${OP}/end_session?id_token_hint=${ghost}${extra}`,
    );
    assertEquals(response.status, 400, await response.text());
  }
  const info = await other.userinfo(theirs.tokens, "user-1");
  assertEquals(info.sub, "user-1", "the login session did not end");
});

Deno.test("DB-OIDC-001: an expired genuine hint is still accepted at authorize and end_session", async () => {
  const { rp, signIn, fetch, time } = await setup();
  const client = rp();
  const done = await signIn(client);
  time.advance(2 * 3600_000);
  const again = await signIn(client, { idTokenHint: done.tokens });
  assertEquals(again.subject, "user-1");
  const response = await fetch(
    `${OP}/end_session?id_token_hint=${done.idToken}`,
  );
  assertEquals(await response.text(), "You are signed out.");
  await rejects(() => client.userinfo(again.tokens, "user-1"), {
    error: "invalid_token",
  });
});

Deno.test("DB-OIDC-001: restored generation aliases are validated before any credential or hint is used", async () => {
  const { rp, signIn, fetch } = await setup();
  let requests = 0;
  const client = rp({
    fetch: async (input, init) => {
      requests++;
      return await fetch(input, init);
    },
  });
  const done = await signIn(client);
  const oauth = await client.oauth();
  for (const field of ["access_token", "id_token"] as const) {
    const altered = { ...done.tokens, [field]: "altered-credential" };
    // The explicitly unsafe low-level restore is synchronous: callers must
    // await immutable generation validation before reading its credentials.
    const restored = oauth.unsafeRestoreGrant(altered);
    const before = requests;
    for (
      const use of [
        () => client.authorizationUrl({ idTokenHint: restored }),
        () => client.logoutUrl({ idTokenHint: restored }),
        () =>
          client.resourceHeaders(
            { method: "GET", url: `${OP}/userinfo` },
            restored,
          ),
        () => client.resourceFetch(`${OP}/userinfo`, restored),
        () => client.userinfo(restored, done.subject),
        () => client.unsafeRestoreGrant(altered),
      ]
    ) {
      await rejects(use, { kind: "token" });
    }
    assertEquals(
      requests,
      before,
      "no altered credential reaches any endpoint",
    );
  }
  const restored = await client.unsafeRestoreGrant(done.tokens);
  assertEquals(
    (await client.userinfo(restored, done.subject)).sub,
    done.subject,
  );
});

Deno.test("DB-OIDC-001: login and logout retain the exact validated hint across awaits", async () => {
  const { rp, signIn, fetch } = await setup();
  const hints: string[] = [];
  const pushed: URLSearchParams[] = [];
  const client = rp({
    fetch: async (input, init) => {
      const request = new Request(input, init);
      if (new URL(request.url).pathname === "/par") {
        const body = new URLSearchParams(await request.clone().text());
        pushed.push(body);
        const hint = body.get("id_token_hint");
        if (hint !== null) hints.push(hint);
      }
      return await fetch(request);
    },
  });
  const done = await signIn(client);
  const oauth = await client.oauth();
  const altered = oauth.unsafeRestoreGrant({
    ...done.tokens,
    id_token: "caller-swapped-hint",
  });
  const loginOptions = {
    idTokenHint: done.tokens,
    extra: {} as Record<string, string>,
    scope: ["profile"],
  };
  const pending = client.authorizationUrl(loginOptions);
  loginOptions.idTokenHint = altered;
  loginOptions.extra.prompt = "none";
  loginOptions.scope.push("email");
  const login = await pending;
  const hint = new URL(login.authorization.url).searchParams.get(
    "id_token_hint",
  );
  assertEquals(hint ?? hints.at(-1), done.tokens.id_token);
  const parameters = pushed.at(-1) ??
    new URL(login.authorization.url).searchParams;
  assertEquals(parameters.get("prompt"), null);
  assertEquals(parameters.get("scope"), "openid profile");

  const logoutOptions = {
    idTokenHint: done.tokens,
    state: "original-state",
    uiLocales: ["en"],
  };
  const pendingLogout = client.logoutUrl(logoutOptions);
  logoutOptions.idTokenHint = altered;
  logoutOptions.state = "mutated-state";
  logoutOptions.uiLocales.push("fr");
  const logout = new URL(await pendingLogout);
  assertEquals(
    logout.searchParams.get("id_token_hint"),
    done.tokens.id_token,
  );
  assertEquals(logout.searchParams.get("state"), "original-state");
  assertEquals(logout.searchParams.get("ui_locales"), "en");
  let reads = 0;
  await rejects(() =>
    client.logoutUrl({
      get idTokenHint() {
        reads++;
        return done.tokens;
      },
    }), { name: "TypeError" });
  assertEquals(reads, 0, "logout refuses accessors without executing them");
  await rejects(() =>
    client.authorizationUrl({
      extra: {
        get prompt() {
          reads++;
          return "none";
        },
      },
    }), { name: "TypeError" });
  assertEquals(
    reads,
    0,
    "nested login data refuses accessors without executing them",
  );
});

// DB-OIDC-003: the provider never falls back to another algorithm.

Deno.test("DB-OIDC-003: a client asking for an ID token algorithm the provider has no key for is refused", async () => {
  await rejects(
    () =>
      setup({
        clients: [{
          client_id: "rsa-app",
          redirect_uris: [CALLBACK],
          id_token_signed_response_alg: "RS256",
        }],
      }),
    { name: "TypeError" },
  );
  const { fetch } = await setup({ registration: {} });
  const register = (metadata: Record<string, unknown>) =>
    fetch(`${OP}/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        redirect_uris: [CALLBACK],
        token_endpoint_auth_method: "none",
        ...metadata,
      }),
    });
  const unsupported = await register({ id_token_signed_response_alg: "RS256" });
  assertEquals(unsupported.status, 400);
  assertEquals(
    (await unsupported.json()).error,
    "invalid_client_metadata",
  );
  const supported = await register({ id_token_signed_response_alg: "ES256" });
  assertEquals(supported.status, 201, await supported.text());
});

// DB-OIDC-005: parsing and session binding.

Deno.test("DB-OIDC-005: an unknown prompt value is invalid_request", async () => {
  const { browser, op } = await setup();
  const callback = new URL(
    await browser.navigate(authorizeUrl([["prompt", "login bogus"]]), CALLBACK),
  );
  assertEquals(callback.searchParams.get("error"), "invalid_request");
  assertEquals(op.interactions.length, 0);
});

Deno.test("DB-OIDC-005: repeated OpenID singleton parameters are invalid_request, directly and pushed", async () => {
  const { browser, fetch, op } = await setup();
  for (
    const name of [
      "nonce",
      "prompt",
      "max_age",
      "claims",
      "id_token_hint",
      "acr_values",
      "login_hint",
      "display",
      "ui_locales",
    ]
  ) {
    const value = name === "max_age"
      ? "60"
      : name === "claims"
      ? "{}"
      : name === "prompt"
      ? "consent"
      : "x";
    const direct = await browser.request(
      authorizeUrl([[name, value], [name, value]]),
    );
    const text = await direct.text();
    const location = direct.headers.get("location");
    assert(
      direct.status === 400 ||
        new URL(location ?? `${CALLBACK}?`).searchParams.get("error") ===
          "invalid_request",
      `${name} repeated: ${direct.status} ${location} ${text}`,
    );
    const body = new URLSearchParams([
      ["response_type", "code"],
      ["client_id", "app"],
      ["redirect_uri", CALLBACK],
      ["scope", "openid"],
      ["code_challenge", CHALLENGE],
      ["code_challenge_method", "S256"],
      [name, value],
      [name, value],
    ]);
    const pushed = await fetch(`${OP}/par`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    });
    assertEquals(pushed.status, 400, `${name} pushed twice`);
    assertEquals((await pushed.json()).error, "invalid_request");
  }
  assertEquals(op.interactions.length, 0);
});

Deno.test("DB-OIDC-005: a refreshed ID token with a nonce is refused", async () => {
  const { op, time } = await setup();
  const inner = routeFetch({ [OP]: op.handle });
  const key = op.keys[0];
  // The provider under test never puts a nonce in a refresh's ID token, so
  // one is added on the way back, re-signed with the provider's own key.
  const fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const response = await inner(input, init);
    const url = new URL(input instanceof Request ? input.url : String(input));
    const body = init?.body === undefined ? "" : String(init.body);
    if (url.pathname !== "/token" || !body.includes("refresh_token")) {
      return response;
    }
    const tokens = await response.json();
    const claims = decode(tokens.id_token).payload;
    tokens.id_token = await sign(
      {
        ...claims,
        nonce: "injected",
        at_hash: await tokenHash(tokens.access_token, key.alg),
      },
      key.privateKey,
      { alg: key.alg, kid: key.kid, typ: "JWT" },
    );
    const headers = new Headers(response.headers);
    headers.delete("content-length");
    return new Response(JSON.stringify(tokens), {
      status: response.status,
      headers,
    });
  };
  const browser = testBrowser(fetch);
  const client = new OidcClient({
    issuer: OP,
    client: { method: "none", clientId: "app" } as ClientAuthentication,
    redirectUri: CALLBACK,
    fetch,
    now: time.now,
  });
  const pending = await client.authorizationUrl();
  const done = await client.completeLogin(
    pending,
    await browser.navigate(pending.authorization.url, CALLBACK),
  );
  await rejects(
    () => client.refresh(done.tokens, done.claims),
    { name: "IdTokenError", code: "nonce" },
  );
});

/**
 * A login, then a refresh whose ID token carries `nonce(original)` (or no
 * nonce for undefined), re-signed with the provider's key on the way back.
 */
async function refreshWithNonce(
  nonce: (original: string) => string | undefined,
) {
  const { op, time } = await setup();
  const inner = routeFetch({ [OP]: op.handle });
  const key = op.keys[0];
  let original = "";
  const fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const response = await inner(input, init);
    const url = new URL(input instanceof Request ? input.url : String(input));
    const body = init?.body === undefined ? "" : String(init.body);
    if (url.pathname !== "/token" || !body.includes("refresh_token")) {
      return response;
    }
    const tokens = await response.json();
    const { nonce: _nonce, ...claims } = decode(tokens.id_token).payload;
    const next = nonce(original);
    tokens.id_token = await sign(
      {
        ...claims,
        ...(next === undefined ? {} : { nonce: next }),
        at_hash: await tokenHash(tokens.access_token, key.alg),
      },
      key.privateKey,
      { alg: key.alg, kid: key.kid, typ: "JWT" },
    );
    const headers = new Headers(response.headers);
    headers.delete("content-length");
    return new Response(JSON.stringify(tokens), {
      status: response.status,
      headers,
    });
  };
  const browser = testBrowser(fetch);
  const client = new OidcClient({
    issuer: OP,
    client: { method: "none", clientId: "app" } as ClientAuthentication,
    redirectUri: CALLBACK,
    fetch,
    now: time.now,
  });
  const pending = await client.authorizationUrl();
  original = pending.nonce;
  const done = await client.completeLogin(
    pending,
    await browser.navigate(pending.authorization.url, CALLBACK),
  );
  return { client, done, original };
}

// Review F13: OpenID Connect Core section 12.2 lets a refreshed ID token
// omit the nonce, or carry the original authentication's unchanged.
Deno.test("refresh accepts no nonce or the original one, and refuses any other", async () => {
  {
    const { client, done } = await refreshWithNonce(() => undefined);
    const refreshed = await client.refresh(done.tokens, done.claims);
    assertEquals(refreshed.claims?.nonce, undefined);
  }
  {
    const { client, done, original } = await refreshWithNonce((n) => n);
    assertEquals(done.claims.nonce, original);
    const refreshed = await client.refresh(done.tokens, done.claims);
    assertEquals(refreshed.claims?.nonce, original);
    assertEquals(refreshed.claims?.sub, done.claims.sub);
  }
  {
    const { client, done } = await refreshWithNonce((n) => `${n}-changed`);
    await rejects(
      () => client.refresh(done.tokens, done.claims),
      { name: "IdTokenError", code: "nonce" },
    );
  }
  {
    // An authentication that had no nonce: one on refresh is new, and
    // refused.
    const { client, done, original } = await refreshWithNonce((n) => n);
    const { nonce: _nonce, ...withoutNonce } = done.claims;
    await rejects(
      () => client.refresh(done.tokens, withoutNonce),
      { name: "IdTokenError", code: "nonce" },
    );
    assert(original.length > 0, "the login sent a nonce");
  }
});

Deno.test("DB-OIDC-005: a login session id is never shared between users", async () => {
  let answer: OidcDecision = {
    grant: { subject: "user-1", authTime: 0, sessionId: "shared" },
  };
  const { rp, login, time } = await setup({ consent: () => answer });
  const client = rp();
  answer = {
    grant: { subject: "user-1", authTime: seconds(time.now), sessionId: "s" },
  };
  const first = await login(client);
  await client.completeLogin(first.pending, first.callback);
  answer = {
    grant: { subject: "user-2", authTime: seconds(time.now), sessionId: "s" },
  };
  const second = await login(client);
  await rejects(() => client.completeLogin(second.pending, second.callback), {
    error: "login_required",
  });
});

Deno.test("DB-OIDC-005: a lost race to create a login session is re-read and re-checked", async () => {
  const time = clock();
  const inner = unsafeMemoryRecordStore({ now: time.now });
  // Another isolate creates the session for user-2 between our read and
  // our create.
  const store: RecordStore = {
    get: (key) => inner.get(key),
    put: (key, value, expiresAt) => inner.put(key, value, expiresAt),
    swap: (key, version, value, expiresAt) =>
      inner.swap(key, version, value, expiresAt),
    delete: (key) => inner.delete(key),
    async create(key, value, expiresAt) {
      if (key.startsWith("oidc-session:")) {
        await inner.create(
          key,
          { subject: "user-2", ended: false },
          expiresAt,
        );
      }
      return await inner.create(key, value, expiresAt);
    },
  };
  const { rp, login } = await setup({ store, now: time.now });
  const client = rp();
  const { pending, callback } = await login(client);
  await rejects(() => client.completeLogin(pending, callback), {
    error: "login_required",
  });
});

Deno.test("DB-OIDC-005: sid is an HMAC under a provider key, and required with session ids", async () => {
  const keys = [await generateSigningKey("ES256", "k")];
  const base = {
    issuer: OP,
    keys,
    store: unsafeMemoryRecordStore(),
    interaction: () => ({ deny: {} }),
    claims: () => ({}),
  };
  const withoutKey = new OpenIdProvider(base);
  await rejects(() => withoutKey.sessionSid("session-1"), {
    name: "TypeError",
  });
  await rejects(
    () =>
      new OpenIdProvider({ ...base, sessionSidKey: "too short" }).sessionSid(
        "x",
      ),
    { name: "TypeError" },
  );
  // Keys that pass the randomness floor (DB-REV-OIDC-6 refuses "a" * 32).
  const a = new OpenIdProvider({
    ...base,
    sessionSidKey: "sid-key-a-0123456789abcdefghijklmnop",
  });
  const b = new OpenIdProvider({
    ...base,
    sessionSidKey: "sid-key-b-0123456789abcdefghijklmnop",
  });
  const unkeyed = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(`${OP}\nsession-1`),
  );
  const hex = [...new Uint8Array(unkeyed)].map((byte) =>
    byte.toString(16).padStart(2, "0")
  ).join("").slice(0, 32);
  const sidA = await a.sessionSid("session-1");
  assert(sidA !== hex, "not the unkeyed hash");
  assert(sidA !== await b.sessionSid("session-1"), "keyed");
  assertEquals(sidA, await a.sessionSid("session-1"));
});

// DB-JWT-002: request objects.

Deno.test("DB-JWT-002: a request object issued far in the future, or without iat, is refused", async () => {
  const { signer, browser, time } = await setup();
  const now = seconds(time.now);
  const object = (claims: Record<string, unknown>) =>
    sign(
      {
        iss: "signed-app",
        aud: OP,
        client_id: "signed-app",
        response_type: "code",
        redirect_uri: CALLBACK,
        scope: "openid",
        code_challenge: CHALLENGE,
        code_challenge_method: "S256",
        state: "ro",
        ...claims,
      },
      signer.privateKey,
      { alg: "ES256", kid: "app-key", typ: "oauth-authz-req+jwt" },
    );
  const go = (jwt: string) =>
    browser.request(`${OP}/authorize?client_id=signed-app&request=${jwt}`);
  const decade = 10 * 365 * 86400;
  const future = await go(
    await object({ iat: now + decade, exp: now + decade + 60, jti: "f-1" }),
  );
  assertEquals(future.status, 400, "ten years ahead");
  const late = await go(
    await object({ iat: now - 30, exp: now + 7200, jti: "f-2" }),
  );
  assertEquals(late.status, 400, "lives past an hour from now");
  const noIat = await go(await object({ exp: now + 60, jti: "f-3" }));
  assertEquals(noIat.status, 400, "no iat");
  const ok = await go(await object({ iat: now, exp: now + 60, jti: "f-4" }));
  assertEquals(ok.status, 303, await ok.text());
});

// DB-OIDC-003: the relying party's algorithm policy.

Deno.test("DB-OIDC-003: an empty ID token algorithm policy is a configuration error, never a token-time one", async () => {
  const { fetch, time, op } = await setup();
  const base = {
    issuer: OP,
    client: { method: "none", clientId: "app" } as ClientAuthentication,
    redirectUri: CALLBACK,
    fetch,
    now: time.now,
  };
  await rejects(
    () =>
      Promise.resolve(
        new OidcClient({
          ...base,
          idTokenAlgorithms: ["ES256"],
          idTokenSignedResponseAlg: "RS256",
        }),
      ),
    { name: "TypeError" },
  );
  const metadata = op.provider.metadata();
  assertEquals(metadata.id_token_signing_alg_values_supported, ["ES256"]);
  await rejects(
    () =>
      Promise.resolve(
        new OidcClient({ ...base, metadata, idTokenAlgorithms: ["RS256"] }),
      ),
    { name: "TypeError" },
  );
  // Discovered: the provider only signs ES256.
  for (
    const more of [
      { idTokenAlgorithms: ["RS256" as const] },
      { idTokenSignedResponseAlg: "ES384" as const },
    ]
  ) {
    const client = new OidcClient({ ...base, ...more });
    await rejects(() => client.authorizationUrl(), {
      name: "OAuthError",
      kind: "discovery",
    });
  }
  const registered = new OidcClient({
    ...base,
    idTokenSignedResponseAlg: "ES256",
  });
  const browser = testBrowser(fetch);
  const pending = await registered.authorizationUrl();
  const done = await registered.completeLogin(
    pending,
    await browser.navigate(pending.authorization.url, CALLBACK),
  );
  assertEquals(done.subject, "user-1");
});

// DB-OAUTH-001 (oidc): resource-bound fetches.

Deno.test("DB-OAUTH-001: resourceFetch refuses URLs the tokens are not for, before any header exists", async () => {
  const { rp, signIn, fetch } = await setup();
  const client = rp({ resources: ["https://api.test/v1"] });
  const done = await signIn(client);
  const before = fetch.requests.length;
  for (
    const url of [
      "https://evil.test/userinfo",
      "https://op.test.evil.test/userinfo",
      "https://op.test:8443/userinfo",
      `${OP}/userinfox`,
      `${OP}/userinfo/../token`,
      `${OP}/userinfo/%2e%2e/token`,
      "http://op.test/userinfo",
      "https://user:pass@op.test/userinfo",
      "https://api.test/v1x",
      "https://api.test/v2/items",
      "not a url",
    ]
  ) {
    await rejects(() => client.resourceFetch(url, done.tokens), {
      name: "OAuthError",
      kind: "target",
    });
    await rejects(
      () => client.resourceHeaders({ method: "GET", url }, done.tokens),
      { name: "OAuthError", kind: "target" },
    );
  }
  assertEquals(fetch.requests.length, before, "nothing was sent");
  const ok = await client.resourceFetch(`${OP}/userinfo`, done.tokens);
  assertEquals(ok.status, 200);
  const sent = fetch.requests.at(-1)!;
  assertEquals(sent.redirect, "manual");
  await rejects(() =>
    client.resourceHeaders(
      { method: "GET", url: "https://api.test/v1/items" },
      done.tokens,
    ), { kind: "target" });
  assertEquals(typeof client.unsafeFetchResource, "function");
  assertEquals(
    (client as unknown as Record<string, unknown>).fetchResource,
    undefined,
  );
});

Deno.test("DB-OAUTH-001: a redirect from the resource is never followed with the token", async () => {
  const { op, time } = await setup();
  const seen: Request[] = [];
  const fetch = routeFetch({
    [OP]: async (request) => {
      if (new URL(request.url).pathname === "/userinfo") {
        seen.push(request);
        return new Response(null, {
          status: 302,
          headers: { location: "https://evil.test/steal" },
        });
      }
      return await op.handle(request);
    },
    "https://evil.test": () => {
      throw new Error("the token followed the redirect");
    },
  });
  const client = new OidcClient({
    issuer: OP,
    client: { method: "none", clientId: "app" } as ClientAuthentication,
    redirectUri: CALLBACK,
    fetch,
    now: time.now,
  });
  const browser = testBrowser(fetch);
  const pending = await client.authorizationUrl();
  const done = await client.completeLogin(
    pending,
    await browser.navigate(pending.authorization.url, CALLBACK),
  );
  await client.resourceFetch(`${OP}/userinfo`, done.tokens).then(
    (response) => response.body?.cancel(),
    () => {},
  );
  assertEquals(seen.length, 1);
  assertEquals(seen[0].redirect, "manual");
});

// DB-NET-001 (oidc): discovery egress.

Deno.test("DB-NET-001: discovery refuses private hosts, redirects, oversized and endless answers", async () => {
  let calls = 0;
  const counting =
    (handler: (request: Request) => Response) =>
    (input: string | URL | Request, init?: RequestInit) => {
      calls++;
      return Promise.resolve(handler(new Request(input, init)));
    };
  for (
    const issuer of [
      "https://10.0.0.1",
      "https://169.254.169.254",
      "https://[::1]",
      "http://127.0.0.1:8080",
    ]
  ) {
    calls = 0;
    await rejects(
      () =>
        discoverOpenIdProvider(issuer, {
          fetch: counting(() => new Response("{}")),
        }),
      { name: "OAuthError" },
    );
    assertEquals(calls, 0, `${issuer} was fetched`);
  }
  const redirect = counting(() =>
    new Response(null, {
      status: 302,
      headers: {
        location: "https://10.0.0.1/.well-known/openid-configuration",
      },
    })
  );
  await rejects(() => discoverOpenIdProvider(OP, { fetch: redirect }), {
    name: "OAuthError",
    kind: "discovery",
  });
  const big = counting(() =>
    new Response(JSON.stringify({ issuer: OP, pad: "x".repeat(200_000) }), {
      headers: { "content-type": "application/json" },
    })
  );
  await rejects(() => discoverOpenIdProvider(OP, { fetch: big }), {
    name: "OAuthError",
  });
  let pulls = 0;
  const endless = counting(() =>
    new Response(
      new ReadableStream<Uint8Array>({
        pull(controller) {
          pulls++;
          controller.enqueue(new Uint8Array(16 * 1024).fill(0x20));
        },
      }),
      { headers: { "content-type": "application/json" } },
    )
  );
  await rejects(() => discoverOpenIdProvider(OP, { fetch: endless }), {
    name: "OAuthError",
  });
  assert(pulls < 64, `the endless body was read ${pulls} times`);
  // Loopback over http only as the development override.
  const local = "http://127.0.0.1:8080";
  const { op } = await setup();
  const served = await testProvider({ issuer: local, keys: op.keys });
  const found = await discoverOpenIdProvider(local, {
    fetch: routeFetch({ [local]: served.handle }),
    allowLoopbackForDevelopment: true,
  });
  assertEquals(found.issuer, local);
});

Deno.test("DB-NET-001: the relying party discovers under the same policy", async () => {
  const { time } = await setup();
  const client = new OidcClient({
    issuer: "https://10.1.2.3",
    client: { method: "none", clientId: "app" } as ClientAuthentication,
    redirectUri: CALLBACK,
    fetch: () => Promise.reject(new Error("fetched")),
    now: time.now,
  });
  const error = await rejects(() => client.metadata(), { name: "OAuthError" });
  assert(error instanceof OAuthError, "an OAuthError");
  assertEquals(error.kind, "discovery");
});

// DB-OIDC-004 and DB-OIDC-005 (broker): refresh races and secret storage.

const SECRET = "the-broker-secret-store-key-0123456789";
/** Where the broker keeps alice's record (keyed by upstream issuer too). */
const ALICE_KEY = brokerRecordKey(
  "https://upstream.test",
  "alice",
  new TextEncoder().encode(SECRET),
);

async function brokerWith(
  secrets: SecretStore,
  refresh: (token: string) => Promise<TokenSet>,
) {
  const time = clock();
  let refreshes = 0;
  const upstream = {
    issuer: "https://upstream.test",
    unsafeRestoreGrant(value: unknown) {
      return Promise.resolve(value);
    },
    async refresh(token: TokenSet) {
      refreshes++;
      return { tokens: await refresh(token.refresh_token!) };
    },
  } as unknown as OidcClient;
  const broker = new UpstreamBroker({
    upstream,
    sealer: await CookieSealer.create({ secret: SECRET, now: time.now }),
    secrets,
    now: time.now,
  });
  const record: UpstreamRecord = {
    issuer: "https://upstream.test",
    tokens: {
      access_token: "old-access",
      token_type: "Bearer",
      refresh_token: "old-refresh",
      expires_at: time.now() + 1_000,
    } as UpstreamRecord["tokens"],
    idToken: {
      iss: "https://upstream.test",
      sub: "alice",
      aud: "broker",
      exp: seconds(time.now) + 600,
      iat: seconds(time.now),
    },
    userinfo: {},
  };
  await secrets.put(await ALICE_KEY, record, time.now() + 86_400_000);
  return { broker, time, refreshes: () => refreshes };
}

Deno.test("DB-OIDC-004: concurrent callers share one upstream refresh and get the committed tokens", async () => {
  const secrets = await encryptedSecretStore(
    unsafeMemoryRecordStore({ now: clock().now }),
    {
      secret: SECRET,
    },
  );
  let release!: () => void;
  const gate = new Promise<void>((resolve) => release = resolve);
  const { broker, refreshes } = await brokerWith(secrets, async (token) => {
    assertEquals(token, "old-refresh");
    await gate;
    return {
      access_token: "new-access",
      token_type: "Bearer",
      refresh_token: "new-refresh",
      expires_at: Date.UTC(2030, 0),
    };
  });
  const first = broker.upstreamTokens("alice");
  const second = broker.upstreamTokens("alice");
  release();
  const [a, b] = await Promise.all([first, second]);
  assertEquals(refreshes(), 1);
  assertEquals(a?.access_token, "new-access");
  assertEquals(b?.access_token, "new-access");
  const stored = await secrets.get<UpstreamRecord>(await ALICE_KEY);
  assertEquals(stored?.value.tokens.refresh_token, "new-refresh");
});

Deno.test("DB-OIDC-004: a refresh that loses the write is never returned; the committed tokens are", async () => {
  const inner = await encryptedSecretStore(
    unsafeMemoryRecordStore({ now: clock().now }),
    {
      secret: SECRET,
    },
  );
  let raced = false;
  // Another isolate commits its own refresh between our read and write.
  const secrets: SecretStore = {
    identityKey: (issuer, subject) => inner.identityKey(issuer, subject),
    get: (key) => inner.get(key),
    put: (key, value, expiresAt) => inner.put(key, value, expiresAt),
    async swap(key, version, value, expiresAt) {
      if (!raced) {
        raced = true;
        const current = await inner.get<UpstreamRecord>(key);
        await inner.swap(key, current!.version, {
          ...current!.value,
          tokens: {
            access_token: "theirs",
            token_type: "Bearer",
            refresh_token: "their-refresh",
            expires_at: Date.UTC(2030, 0),
          },
        }, current!.expiresAt);
      }
      return await inner.swap(key, version, value, expiresAt);
    },
  };
  const { broker, refreshes } = await brokerWith(
    secrets,
    () =>
      Promise.resolve({
        access_token: "ours",
        token_type: "Bearer",
        refresh_token: "our-refresh",
        expires_at: Date.UTC(2030, 0),
      }),
  );
  const tokens = await broker.upstreamTokens("alice");
  assertEquals(tokens?.access_token, "theirs");
  assertEquals(
    refreshes(),
    0,
    "the lost refresh intent is detected before contacting upstream",
  );
  const stored = await inner.get<UpstreamRecord>(await ALICE_KEY);
  assertEquals(stored?.value.tokens.access_token, "theirs");
});

Deno.test("DB-OIDC-013: separate broker isolates fence one rotation and refuse uncertain crash recovery", async () => {
  const time = clock();
  const secrets = await encryptedSecretStore(
    unsafeMemoryRecordStore({ now: time.now }),
    { secret: SECRET },
  );
  let release!: () => void;
  const gate = new Promise<void>((resolve) => release = resolve);
  const refresh = async () => {
    await gate;
    return {
      access_token: "committed",
      token_type: "Bearer" as const,
      refresh_token: "rotated",
      expires_at: time.now() + 600000,
    };
  };
  const first = await brokerWith(secrets, refresh);
  const second = await brokerWith(secrets, refresh);
  const one = first.broker.upstreamTokens("alice"),
    two = second.broker.upstreamTokens("alice");
  release();
  const results = await Promise.all([one, two]);
  assertEquals(first.refreshes() + second.refreshes(), 1);
  assertEquals(results.map((value) => value?.access_token), [
    "committed",
    "committed",
  ]);
  const stored = (await secrets.get<UpstreamRecord>(await ALICE_KEY))!;
  await secrets.swap(await ALICE_KEY, stored.version, {
    ...stored.value,
    refreshIntent: { owner: "crashed", until: time.now() - 1 },
  }, stored.expiresAt);
  await rejects(() => second.broker.upstreamTokens("alice"), {
    code: "invalid_grant",
  });
  assertEquals(
    first.refreshes() + second.refreshes(),
    1,
    "uncertain rotation is never retried",
  );
});

Deno.test("DB-OIDC-005: the broker's secret store encrypts at rest, bound to the key", async () => {
  const records = unsafeMemoryRecordStore();
  const secrets = await encryptedSecretStore(records, { secret: SECRET });
  const value = { tokens: { access_token: "the-access-token-value" } };
  await secrets.put("broker:alice", value, null);
  const raw = await records.get<unknown>("broker:alice");
  assert(raw !== null, "stored");
  assert(
    !JSON.stringify(raw.value).includes("the-access-token-value"),
    "the token is not stored in the clear",
  );
  assertEquals((await secrets.get("broker:alice"))?.value, value);
  // Moved to another key, it does not open.
  await records.put("broker:mallory", raw.value, null);
  assertEquals(await secrets.get("broker:mallory"), null);
  // Another key does not open it; a previous one does.
  const other = await encryptedSecretStore(records, {
    secret: "another-broker-secret-store-key-0123",
  });
  assertEquals(await other.get("broker:alice"), null);
  const rotated = await encryptedSecretStore(records, {
    secret: "another-broker-secret-store-key-0123",
    previous: [SECRET],
  });
  assertEquals((await rotated.get("broker:alice"))?.value, value);
  // That read sealed it again under the current secret (DB-REV-OIDC-5).
  assertEquals(await secrets.get("broker:alice"), null);
  const stored = await rotated.get("broker:alice");
  assert(
    await rotated.swap("broker:alice", stored!.version, { changed: 1 }, null),
    "swap at the current version",
  );
  assertEquals(
    await rotated.swap("broker:alice", stored!.version, { changed: 2 }, null),
    false,
  );
  await rejects(
    () => encryptedSecretStore(records, { secret: "short" }),
    { name: "TypeError" },
  );
});

// DB-OIDC-002 and DB-NET-001 (federation): one resolution, bounded.

const TA = "https://ta.test";
const MARK = "https://ta.test/marks/any";

/** Settles `work` or fails after `ms`: an unbounded resolution must not hang the suite. */
async function within<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: number | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`did not settle within ${ms} ms`)),
      ms,
    );
  });
  try {
    return await Promise.race([work, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/** TA (any issuer of MARK accepted) with leaves A and B directly below it. */
async function federation() {
  const time = clock();
  const ta = await node(TA, { now: time.now });
  const a = await node("https://a.test", { now: time.now });
  const b = await node("https://b.test", { now: time.now });
  rebuild(ta, {
    now: time.now,
    trustMarkIssuers: { [MARK]: [] },
    subordinates: { [a.id]: { jwks: a.jwks }, [b.id]: { jwks: b.jwks } },
  });
  for (const item of [a, b]) {
    rebuild(item, { now: time.now, authorityHints: [TA] });
  }
  const fetch = routeFetch(handlers([ta, a, b]));
  const resolver = (options: Partial<TrustChainResolverOptions> = {}) =>
    new TrustChainResolver({
      trustAnchors: [{ entityId: TA, jwks: ta.jwks }],
      fetch,
      now: time.now,
      ...options,
    });
  return { time, ta, a, b, fetch, resolver };
}

Deno.test("DB-OIDC-002: a self-issued trust mark settles at once with a cycle error", async () => {
  const w = await federation();
  const mark = await w.a.entity.issueTrustMark(w.a.id, MARK);
  rebuild(w.a, {
    now: w.time.now,
    authorityHints: [TA],
    trustMarks: [{ trust_mark_type: MARK, trust_mark: mark }],
  });
  const chain = await within(w.resolver().resolve(w.a.id), 2_000);
  assertEquals(chain.trustMarks, []);
  assertEquals(chain.rejectedTrustMarks.length, 1);
  assertEquals(chain.rejectedTrustMarks[0].code, "cycle");
  assert(w.fetch.requests.length <= 4, `${w.fetch.requests.length} fetches`);
});

Deno.test("DB-OIDC-002: an A <-> B trust mark issuer cycle settles with a bounded fetch count", async () => {
  const w = await federation();
  const byB = await w.b.entity.issueTrustMark(w.a.id, MARK);
  const byA = await w.a.entity.issueTrustMark(w.b.id, MARK);
  rebuild(w.a, {
    now: w.time.now,
    authorityHints: [TA],
    trustMarks: [{ trust_mark_type: MARK, trust_mark: byB }],
  });
  rebuild(w.b, {
    now: w.time.now,
    authorityHints: [TA],
    trustMarks: [{ trust_mark_type: MARK, trust_mark: byA }],
  });
  const chain = await within(w.resolver().resolve(w.a.id), 2_000);
  assertEquals(chain.trustMarks.map((mark) => mark.issuer), [w.b.id]);
  assert(w.fetch.requests.length <= 8, `${w.fetch.requests.length} fetches`);
  const other = await within(w.resolver().resolve(w.b.id), 2_000);
  assertEquals(other.trustMarks.map((mark) => mark.issuer), [w.a.id]);
});

Deno.test("DB-OIDC-002: trust mark issuers share the resolution's one budget", async () => {
  const time = clock();
  const ta = await node(TA, { now: time.now });
  const leaf = await node("https://leaf.test", { now: time.now });
  const issuers = await Promise.all(
    [...Array(8).keys()].map((i) =>
      node(`https://issuer-${i}.test`, { now: time.now })
    ),
  );
  rebuild(ta, {
    now: time.now,
    trustMarkIssuers: { [MARK]: [] },
    subordinates: Object.fromEntries(
      [leaf, ...issuers].map((item) => [item.id, { jwks: item.jwks }]),
    ),
  });
  for (const item of issuers) {
    rebuild(item, { now: time.now, authorityHints: [TA] });
  }
  rebuild(leaf, {
    now: time.now,
    authorityHints: [TA],
    trustMarks: await Promise.all(
      issuers.map(async (item) => ({
        trust_mark_type: MARK,
        trust_mark: await item.entity.issueTrustMark(leaf.id, MARK),
      })),
    ),
  });
  const fetch = routeFetch(handlers([ta, leaf, ...issuers]));
  const resolver = new TrustChainResolver({
    trustAnchors: [{ entityId: TA, jwks: ta.jwks }],
    fetch,
    now: time.now,
    maxFetches: 10,
  });
  const error = await rejects(() => within(resolver.resolve(leaf.id), 2_000), {
    name: "FederationError",
    code: "budget",
  });
  assert(error instanceof FederationError, "a federation error");
  assert(fetch.requests.length <= 10, `${fetch.requests.length} fetches`);
});

Deno.test("DB-NET-001: federation fetches refuse private targets, redirects, endless and oversized bodies", async () => {
  const w = await federation();
  const resolveThrough = (
    answer: (request: Request) => Response | Promise<Response>,
  ) => {
    const seen: string[] = [];
    const fetch = routeFetch({
      ...handlers([w.ta]),
      [w.a.id]: (request) => {
        seen.push(request.url);
        return answer(request);
      },
    });
    const resolver = new TrustChainResolver({
      trustAnchors: [{ entityId: TA, jwks: w.ta.jwks }],
      fetch,
      now: w.time.now,
    });
    return { seen, resolve: () => within(resolver.resolve(w.a.id), 10_000) };
  };
  // A private or link-local entity is never fetched.
  for (const target of ["https://10.0.0.1", "https://169.254.169.254"]) {
    let fetched = 0;
    const resolver = w.resolver({
      fetch: () => {
        fetched++;
        return Promise.resolve(new Response("", { status: 500 }));
      },
    });
    await rejects(() => resolver.resolve(target), { name: "FederationError" });
    assertEquals(fetched, 0, `${target} was fetched`);
  }
  const redirect = resolveThrough(() =>
    new Response(null, {
      status: 302,
      headers: { location: "https://10.0.0.1/.well-known/openid-federation" },
    })
  );
  await rejects(redirect.resolve, { name: "FederationError" });
  assertEquals(redirect.seen.length, 1);
  let pulls = 0;
  const endless = resolveThrough(() =>
    new Response(
      new ReadableStream<Uint8Array>({
        pull(controller) {
          pulls++;
          controller.enqueue(new Uint8Array(64 * 1024).fill(0x41));
        },
      }),
      {
        headers: {
          "content-type": `application/${MEDIA_TYPES.entityStatement}`,
        },
      },
    )
  );
  await rejects(endless.resolve, { name: "FederationError" });
  assert(pulls <= 8, `the endless body was read ${pulls} times`);
  const oversized = resolveThrough(() =>
    new Response("A".repeat(300 * 1024), {
      headers: {
        "content-type": `application/${MEDIA_TYPES.entityStatement}`,
      },
    })
  );
  await rejects(oversized.resolve, { name: "FederationError" });
  let hung = false;
  const slow = resolveThrough((request) =>
    new Promise((_, reject) => {
      hung = true;
      request.signal.addEventListener("abort", () =>
        reject(request.signal.reason));
    })
  );
  const started = Date.now();
  await rejects(slow.resolve, { name: "FederationError" });
  assert(hung, "the fetch was made");
  assert(Date.now() - started < 9_000, "the deadline ended the fetch");
});

Deno.test("DB-NET-001: the public resolve endpoint refuses private subjects and bounds its work", async () => {
  const w = await federation();
  let fetched = 0;
  const resolver = w.resolver({
    fetch: (input, init) => {
      fetched++;
      return w.fetch(input, init);
    },
  });
  rebuild(w.ta, {
    now: w.time.now,
    resolver,
    subordinates: { [w.a.id]: { jwks: w.a.jwks } },
  });
  const ask = (query: string) =>
    w.ta.entity.handle(new Request(`${TA}/federation_resolve?${query}`));
  for (
    const sub of [
      "https://10.1.2.3",
      "https://169.254.169.254",
      "https://[fd00::1]",
    ]
  ) {
    const response = await ask(
      `sub=${encodeURIComponent(sub)}&trust_anchor=${encodeURIComponent(TA)}`,
    );
    assertEquals(response?.status, 400, sub);
  }
  const anchors = [...Array(20).keys()].map((i) =>
    `trust_anchor=${encodeURIComponent(`https://ta-${i}.test`)}`
  ).join("&");
  const many = await ask(`sub=${encodeURIComponent(w.a.id)}&${anchors}`);
  assertEquals(many?.status, 400);
  assertEquals(fetched, 0);
  const ok = await ask(
    `sub=${encodeURIComponent(w.a.id)}&trust_anchor=${encodeURIComponent(TA)}`,
  );
  assertEquals(ok?.status, 200);
});

Deno.test("DB-NET-001: federation key sets hold at most 64 keys", async () => {
  const time = clock();
  const signer = await node("https://big.test", { now: time.now });
  const keys = await Promise.all(
    [...Array(65).keys()].map((i) => generateSigningKey("ES256", `k-${i}`)),
  );
  const iat = seconds(time.now);
  const claims = {
    iss: signer.id,
    sub: signer.id,
    iat,
    exp: iat + 600,
    jwks: federationJwks([signer.key, ...keys]),
  };
  // A token that size is refused by @celld/sec/jwt's size limit already; the
  // count is checked on the claims whatever the limit.
  await rejects(
    () => Promise.resolve(checkStatementClaims(claims)),
    { name: "FederationError", code: "malformed" },
  );
  const owners = {
    iss: signer.id,
    sub: signer.id,
    iat,
    exp: iat + 600,
    jwks: federationJwks([signer.key]),
    trust_mark_owners: {
      [MARK]: { sub: signer.id, jwks: federationJwks(keys) },
    },
  };
  await rejects(
    () => Promise.resolve(checkStatementClaims(owners)),
    { name: "FederationError", code: "malformed" },
  );
  const fine = checkStatementClaims({
    ...claims,
    jwks: federationJwks(keys.slice(0, 64)),
  });
  assertEquals(fine.jwks?.keys.length, 64);
  assert(
    FederationEntity !== undefined && signStatement !== undefined,
    "exported",
  );
  assert(verifyStatement !== undefined, "exported");
});

// DB-REV-OIDC-1: trust marks never outlive their expiry in the chain cache.

Deno.test("DB-REV-OIDC-1: a cached chain drops a trust mark once it expires, and so does the resolve endpoint", async () => {
  const w = await federation();
  const mark = await w.ta.entity.issueTrustMark(w.a.id, MARK, { ttlSec: 60 });
  rebuild(w.a, {
    now: w.time.now,
    authorityHints: [TA],
    trustMarks: [{ trust_mark_type: MARK, trust_mark: mark }],
  });
  const resolver = w.resolver();
  rebuild(w.ta, {
    now: w.time.now,
    resolver,
    trustMarkIssuers: { [MARK]: [] },
    subordinates: {
      [w.a.id]: { jwks: w.a.jwks },
      [w.b.id]: { jwks: w.b.jwks },
    },
  });
  const first = await resolver.resolve(w.a.id);
  assertEquals(first.trustMarks.map((item) => item.trustMarkType), [MARK]);
  const markExp = first.trustMarks[0].expiresAt!;
  assert(first.expiresAt <= markExp, "the chain expires with its mark");
  const ask = () =>
    w.ta.entity.handle(
      new Request(
        `${TA}/federation_resolve?sub=${encodeURIComponent(w.a.id)}` +
          `&trust_anchor=${encodeURIComponent(TA)}`,
      ),
    );
  const before = await ask();
  assertEquals(before?.status, 200);
  const early = decode(await before!.text()).payload;
  assertEquals((early.trust_marks as unknown[]).length, 1);
  assert(
    (early.exp as number) <= markExp,
    "a resolve response carrying the mark expires with it",
  );
  w.time.advance(3600_000);
  const later = await resolver.resolve(w.a.id);
  assertEquals(later.trustMarks, [], "the same resolver");
  assertEquals(later.rejectedTrustMarks.map((item) => item.code), [
    "trust_mark",
  ]);
  const after = await ask();
  assertEquals(after?.status, 200);
  assertEquals(decode(await after!.text()).payload.trust_marks, []);
});

// Review F04: a mark is accepted because its issuer has a trust chain to
// the anchor; once that chain expires, so does the mark's standing.
Deno.test("an accepted trust mark lives no longer than its issuer's trust chain", async () => {
  const time = clock();
  const start = seconds(time.now);
  const leaf = "https://leaf.test";
  const marks = "https://marks.test";
  const type = `${TA}/certified`;
  const [taKey, leafKey, markKey] = await Promise.all([
    generateSigningKey("ES256", "anchor"),
    generateSigningKey("ES256", "leaf"),
    generateSigningKey("ES256", "marks"),
  ]);
  const taJwks = federationJwks([taKey]);
  const leafJwks = federationJwks([leafKey]);
  const markJwks = federationJwks([markKey]);
  const mark = await issueTrustMark(markKey, {
    issuer: marks,
    subject: leaf,
    trustMarkType: type,
    ttlSec: 1800,
    now: time.now,
  });
  const statement = (claims: Record<string, unknown>) =>
    signStatement({ iat: start, ...claims }, taKey);
  const taConfig = await statement({
    iss: TA,
    sub: TA,
    exp: start + 3600,
    jwks: taJwks,
    metadata: {
      federation_entity: { federation_fetch_endpoint: `${TA}/fetch` },
    },
    trust_mark_issuers: { [type]: [marks] },
  });
  const leafConfig = await signStatement({
    iss: leaf,
    sub: leaf,
    iat: start,
    exp: start + 3600,
    jwks: leafJwks,
    authority_hints: [TA],
    trust_marks: [{ trust_mark_type: type, trust_mark: mark }],
  }, leafKey);
  // The issuer's configuration and the anchor's statement about it expire
  // after ten seconds, and nobody renews them.
  const markConfig = await signStatement({
    iss: marks,
    sub: marks,
    iat: start,
    exp: start + 10,
    jwks: markJwks,
    authority_hints: [TA],
  }, markKey);
  const leafStatement = await statement({
    iss: TA,
    sub: leaf,
    exp: start + 3600,
    jwks: leafJwks,
  });
  const markStatement = await statement({
    iss: TA,
    sub: marks,
    exp: start + 10,
    jwks: markJwks,
  });
  const response = (jwt: string) =>
    new Response(jwt, {
      headers: { "content-type": "application/entity-statement+jwt" },
    });
  const fetch = routeFetch({
    [TA]: (request) => {
      const url = new URL(request.url);
      return Promise.resolve(response(
        url.pathname === "/fetch"
          ? url.searchParams.get("sub") === leaf ? leafStatement : markStatement
          : taConfig,
      ));
    },
    [leaf]: () => Promise.resolve(response(leafConfig)),
    [marks]: () => Promise.resolve(response(markConfig)),
  });
  const resolver = new TrustChainResolver({
    trustAnchors: [{ entityId: TA, jwks: taJwks }],
    fetch,
    now: time.now,
    clockToleranceSec: 0,
  });
  const first = await resolver.resolve(leaf);
  assertEquals(first.trustMarks.length, 1);
  assertEquals(first.expiresAt, start + 10, "the issuer's chain counts");
  // A cache hit a second before: the mark still stands.
  time.advance(9_000);
  assertEquals((await resolver.resolve(leaf)).trustMarks.length, 1);
  time.advance(2_000);
  const later = await resolver.resolve(leaf);
  assertEquals(
    later.trustMarks.length,
    0,
    `the issuer's chain expired at ${start + 10}`,
  );
  assertEquals(later.rejectedTrustMarks.length, 1);
  // Only the mark goes: the leaf's own chain is as long as it ever was.
  assertEquals(later.expiresAt, start + 3600);
});

Deno.test("a resolve response lives no longer than its marks' issuers, and a rejected mark shortens nothing", async () => {
  const w = await federation();
  // B's configuration lives ten seconds (re-signed on every fetch); A's
  // and the anchor's a day.
  rebuild(w.b, { now: w.time.now, authorityHints: [TA], ttlSec: 10 });
  const start = seconds(w.time.now);
  const mark = await w.b.entity.issueTrustMark(w.a.id, MARK, {
    ttlSec: 3600,
  });
  const other = await w.b.entity.issueTrustMark(w.b.id, MARK, {
    ttlSec: 3600,
  });
  // B's mark with the signature of another: B's chain is resolved for its
  // keys, then the mark is rejected.
  const forged = mark.slice(0, mark.lastIndexOf(".")) +
    other.slice(other.lastIndexOf("."));
  const carrying = (trustMark: string) =>
    rebuild(w.a, {
      now: w.time.now,
      authorityHints: [TA],
      trustMarks: [{ trust_mark_type: MARK, trust_mark: trustMark }],
    });

  carrying(forged);
  const rejected = await w.resolver().resolve(w.a.id);
  assertEquals(rejected.trustMarks, []);
  assertEquals(rejected.rejectedTrustMarks.length, 1);
  assertEquals(rejected.expiresAt, start + 86400, "a rejected mark");

  carrying(mark);
  let down = false;
  const resolver = w.resolver({
    fetch: (input, init) => {
      const url = String(input instanceof Request ? input.url : input);
      if (down && new URL(url).origin === w.b.id) {
        return Promise.resolve(new Response("down", { status: 503 }));
      }
      return w.fetch(input, init);
    },
  });
  rebuild(w.ta, {
    now: w.time.now,
    resolver,
    trustMarkIssuers: { [MARK]: [] },
    subordinates: {
      [w.a.id]: { jwks: w.a.jwks },
      [w.b.id]: { jwks: w.b.jwks },
    },
  });
  const ask = async () => {
    const answer = await w.ta.entity.handle(
      new Request(
        `${TA}/federation_resolve?sub=${encodeURIComponent(w.a.id)}` +
          `&trust_anchor=${encodeURIComponent(TA)}`,
      ),
    );
    assertEquals(answer?.status, 200);
    return decode(await answer!.text()).payload;
  };
  const accepted = await resolver.resolve(w.a.id);
  assertEquals(accepted.trustMarks.map((item) => item.issuer), [w.b.id]);
  assertEquals(accepted.expiresAt, start + 10);
  const early = await ask();
  assertEquals((early.trust_marks as unknown[]).length, 1);
  assert(
    (early.exp as number) <= start + 10,
    `a resolve response carrying B's mark outlives B's chain: ${early.exp}`,
  );
  // B's chain has expired and B cannot be reached to renew it: neither the
  // resolver's cache nor the resolve endpoint still vouches for the mark.
  down = true;
  w.time.advance(11_000);
  const later = await resolver.resolve(w.a.id);
  assertEquals(later.trustMarks, []);
  assertEquals(later.rejectedTrustMarks.length, 1);
  assertEquals((await ask()).trust_marks, []);
});

Deno.test("DB-REV-OIDC-1: a mark rejected because its issuer was unreachable is retried soon", async () => {
  const w = await federation();
  const mark = await w.b.entity.issueTrustMark(w.a.id, MARK, {
    ttlSec: 86400,
  });
  rebuild(w.a, {
    now: w.time.now,
    authorityHints: [TA],
    trustMarks: [{ trust_mark_type: MARK, trust_mark: mark }],
  });
  let down = true;
  const resolver = w.resolver({
    fetch: (input, init) => {
      const url = String(input instanceof Request ? input.url : input);
      if (down && new URL(url).origin === w.b.id) {
        return Promise.resolve(new Response("down", { status: 503 }));
      }
      return w.fetch(input, init);
    },
  });
  const first = await resolver.resolve(w.a.id);
  assertEquals(first.trustMarks, []);
  assertEquals(first.rejectedTrustMarks.length, 1);
  down = false;
  w.time.advance(120_000);
  const later = await resolver.resolve(w.a.id);
  assertEquals(later.trustMarks.map((item) => item.issuer), [w.b.id]);
});

// DB-REV-OIDC-7: repeated parameters inside a request object.

Deno.test("DB-REV-OIDC-7: a request object with a repeated singleton is refused, and its values win over the query's", async () => {
  const { signer, browser, time, op } = await setup();
  const now = seconds(time.now);
  let jti = 0;
  const object = (claims: Record<string, unknown>) =>
    sign(
      {
        iss: "signed-app",
        aud: OP,
        client_id: "signed-app",
        response_type: "code",
        redirect_uri: CALLBACK,
        scope: "openid",
        code_challenge: CHALLENGE,
        code_challenge_method: "S256",
        state: "ro",
        iat: now,
        exp: now + 60,
        jti: `r-${jti++}`,
        ...claims,
      },
      signer.privateKey,
      { alg: "ES256", kid: "app-key", typ: "oauth-authz-req+jwt" },
    );
  for (
    const [name, values] of [
      ["prompt", ["login", "consent"]],
      ["nonce", ["n-1", "n-2"]],
    ] as const
  ) {
    const response = await browser.request(
      `${OP}/authorize?client_id=signed-app&request=${await object({
        [name]: values,
      })}`,
    );
    assertEquals(response.status, 400, name);
    assertEquals(
      await response.text(),
      `invalid_request_object: ${name} must be a single value`,
    );
  }
  assertEquals(op.interactions.length, 0);
  const ok = await browser.request(
    `${OP}/authorize?client_id=signed-app&prompt=none&nonce=outer&request=${await object(
      { prompt: "login", nonce: "inner" },
    )}`,
  );
  assertEquals(ok.status, 303, await ok.text());
  assertEquals(op.interactions.length, 1);
  assertEquals(op.interactions[0].prompt, ["login"]);
  assertEquals(op.interactions[0].params.nonce, "inner");
});

// Carry-over (WP-13b): configuration snapshots keep an own `__proto__` key as data.

/**
 * Runs `work` with `Object.prototype.__proto__` as Workers and browsers
 * have it (Deno leaves the accessor out), so `copy["__proto__"] = x` sets
 * a prototype as it would in production.
 */
async function withProtoAccessor(work: () => Promise<void>): Promise<void> {
  Object.defineProperty(Object.prototype, "__proto__", {
    configurable: true,
    get(this: object) {
      return Object.getPrototypeOf(this);
    },
    set(this: object, value: unknown) {
      if (typeof value === "object") {
        Object.setPrototypeOf(this, value as object | null);
      }
    },
  });
  try {
    await work();
  } finally {
    delete (Object.prototype as Record<string, unknown>).__proto__;
  }
}

Deno.test("configuration snapshots never turn an own __proto__ key into a prototype", () =>
  withProtoAccessor(async () => {
    const w = await federation();
    const top = new TrustChainResolver({
      ...JSON.parse('{"__proto__": {"maxFetches": 1, "maxNodes": 1}}'),
      trustAnchors: [{ entityId: TA, jwks: w.ta.jwks }],
      fetch: w.fetch,
      now: w.time.now,
    });
    assertEquals(top.budget(), { fetches: 64, nodes: 256 });
    const anchor = JSON.parse(
      `{"__proto__": {"entityId": "${TA}"}, "jwks": ${
        JSON.stringify(w.ta.jwks)
      }}`,
    );
    assert(Object.hasOwn(anchor, "__proto__"), "JSON.parse makes an own key");
    await rejects(
      () =>
        Promise.resolve(
          new TrustChainResolver({
            trustAnchors: [anchor],
            fetch: w.fetch,
            now: w.time.now,
          }),
        ),
      { name: "TypeError" },
    );
  }));

// DB-REV-OIDC-5: a value opened with a previous secret is sealed again under the current one.

Deno.test("DB-REV-OIDC-5: reading a value sealed under a previous secret re-seals it under the current one", async () => {
  const records = unsafeMemoryRecordStore();
  const OLD = "an-old-broker-secret-store-key-0123456789";
  const NEW = "a-new-broker-secret-store-key-0123456789ab";
  const value = { tokens: { access_token: "the-access-token-value" } };
  const old = await encryptedSecretStore(records, { secret: OLD });
  await old.put("broker:alice", value, Date.now() + 3600_000);
  const before = await records.get<unknown>("broker:alice");
  const rotated = await encryptedSecretStore(records, {
    secret: NEW,
    previous: [OLD],
  });
  const read = await rotated.get("broker:alice");
  assertEquals(read?.value, value);
  assertEquals(read?.expiresAt, before?.expiresAt, "the expiry is kept");
  const dropped = await encryptedSecretStore(records, { secret: NEW });
  assertEquals((await dropped.get("broker:alice"))?.value, value);
  assertEquals(await old.get("broker:alice"), null, "no longer under the old");
  // The version get answered is the re-sealed record's, so a
  // compare-and-swap at it still wins.
  assert(
    await rotated.swap("broker:alice", read!.version, { changed: 1 }, null),
    "swap at the version get answered",
  );
});

// DB-REV-OIDC-6: operator secrets must look random, and the public test key is for testProvider only.

Deno.test("DB-REV-OIDC-6: an obviously non-random secret, or the public test key, is a TypeError", async () => {
  const base = {
    issuer: OP,
    keys: [await generateSigningKey("ES256", "k")],
    store: unsafeMemoryRecordStore(),
    interaction: () => ({ deny: {} }),
    claims: () => ({}),
  };
  for (
    const weak of [
      "a".repeat(32),
      "changeme".repeat(4),
      new Uint8Array(32),
      TEST_SESSION_SID_KEY,
      new TextEncoder().encode(TEST_SESSION_SID_KEY),
    ]
  ) {
    await rejects(
      () =>
        Promise.resolve(new OpenIdProvider({ ...base, sessionSidKey: weak })),
      { name: "TypeError" },
    );
  }
  const random = crypto.getRandomValues(new Uint8Array(32));
  new OpenIdProvider({ ...base, sessionSidKey: random });
  const records = unsafeMemoryRecordStore();
  for (const weak of ["a".repeat(32), new Uint8Array(40)]) {
    await rejects(() => encryptedSecretStore(records, { secret: weak }), {
      name: "TypeError",
    });
    await rejects(
      () => encryptedSecretStore(records, { secret: SECRET, previous: [weak] }),
      { name: "TypeError" },
    );
    await rejects(() => CookieSealer.create({ secret: weak }), {
      name: "TypeError",
    });
  }
  await encryptedSecretStore(records, { secret: random });
  // testProvider still signs in with its public key.
  const { signIn, rp } = await setup();
  const done = await signIn(rp());
  assert(typeof done.claims.sid === "string", "a sid");
});

// DB-REV-OIDC-4: federated client lookups are no request amplifier.

/** A fetch that serves `nodes`, answers 404 elsewhere, and counts requests by origin. */
function countingFetch(nodes: readonly Awaited<ReturnType<typeof node>>[]) {
  const routes = handlers(nodes);
  const byOrigin = new Map<string, number>();
  const fetch = async (input: string | URL | Request, init?: RequestInit) => {
    const request = new Request(input, init);
    const origin = new URL(request.url).origin;
    byOrigin.set(origin, (byOrigin.get(origin) ?? 0) + 1);
    const route = routes[origin];
    return route === undefined
      ? new Response("not found", { status: 404 })
      : await route(request);
  };
  const total = () => [...byOrigin.values()].reduce((a, b) => a + b, 0);
  return { fetch, byOrigin, total };
}

Deno.test("DB-REV-OIDC-4: an unknown client id with 32 authority hints costs at most the lookup's budget", async () => {
  const time = clock();
  const ta = await node(TA, { now: time.now });
  const leaf = await node("https://atk.test", {
    now: time.now,
    authorityHints: [...Array(32).keys()].map((i) => `https://hop-${i}.test`),
  });
  const counted = countingFetch([ta, leaf]);
  const resolver = new TrustChainResolver({
    trustAnchors: [{ entityId: TA, jwks: ta.jwks }],
    fetch: counted.fetch,
    now: time.now,
  });
  const lookup = federatedClients({ resolver, now: time.now });
  assertEquals(await lookup(leaf.id), null);
  assert(counted.total() <= 16, `${counted.total()} fetches`);
  const narrow = federatedClients({
    resolver,
    now: time.now,
    resolveBudget: { fetches: 4 },
  });
  const before = counted.total();
  assertEquals(await narrow(`${leaf.id}/other`), null);
  assert(counted.total() - before <= 4, `${counted.total() - before} fetches`);
});

Deno.test("DB-REV-OIDC-4: one resolution fetches a URL once, however many superiors name it", async () => {
  const time = clock();
  const ta = await node(TA, { now: time.now });
  const victim = "https://victim.test/any?path";
  const superiors = await Promise.all(
    [...Array(8).keys()].map((i) =>
      node(`https://sup-${i}.test`, {
        now: time.now,
        metadata: {
          federation_entity: { federation_fetch_endpoint: victim },
        },
      })
    ),
  );
  const leaf = await node("https://atk.test", {
    now: time.now,
    authorityHints: superiors.map((item) => item.id),
  });
  const counted = countingFetch([ta, leaf, ...superiors]);
  const resolver = new TrustChainResolver({
    trustAnchors: [{ entityId: TA, jwks: ta.jwks }],
    fetch: counted.fetch,
    now: time.now,
  });
  await rejects(() => resolver.resolve(leaf.id), {
    name: "FederationError",
    code: "chain",
  });
  assertEquals(counted.byOrigin.get("https://victim.test"), 1);
});

Deno.test("DB-REV-OIDC-4: fetches to one origin are rate limited across resolutions", async () => {
  const time = clock();
  const ta = await node(TA, { now: time.now });
  const counted = countingFetch([ta]);
  const resolver = new TrustChainResolver({
    trustAnchors: [{ entityId: TA, jwks: ta.jwks }],
    fetch: counted.fetch,
    now: time.now,
    fetchRate: { perOrigin: 3, windowSec: 60 },
  });
  const lookup = federatedClients({ resolver, now: time.now });
  for (let i = 0; i < 6; i++) {
    assertEquals(await lookup(`https://atk.test/${i}`), null);
  }
  assertEquals(counted.byOrigin.get("https://atk.test"), 3);
  time.advance(61_000);
  assertEquals(await lookup("https://atk.test/again"), null);
  assertEquals(counted.byOrigin.get("https://atk.test"), 4);
  await rejects(
    () =>
      Promise.resolve(
        new TrustChainResolver({
          trustAnchors: [{ entityId: TA, jwks: ta.jwks }],
          fetchRate: { perOrigin: 0, windowSec: 60 },
        }),
      ),
    { name: "BoundsError" },
  );
});

// DB-REV-OIDC-2: an old ID token hint ends no login session by itself.

Deno.test("DB-REV-OIDC-2: a hint older than endSessionHintMaxAgeSec ends nothing; a fresh one still does", async () => {
  const { rp, signIn, fetch, time } = await setup({
    endSessionHintMaxAgeSec: 1800,
  });
  const client = rp();
  const done = await signIn(client);
  time.advance(3600_000);
  const old = await fetch(`${OP}/end_session?id_token_hint=${done.idToken}`);
  assertEquals(old.status, 200, "the hint still names the client");
  // The access token has expired by now; the refresh token shows the
  // login session is alive.
  const refreshed = await client.refresh(
    done.tokens,
    done.claims,
  );
  const info = await client.userinfo(refreshed.tokens, "user-1");
  assertEquals(info.sub, "user-1", "the login session did not end");
  const fresh = await signIn(client);
  const response = await fetch(
    `${OP}/end_session?id_token_hint=${fresh.idToken}`,
  );
  assertEquals(await response.text(), "You are signed out.");
  await rejects(() => client.userinfo(fresh.tokens, "user-1"), {
    error: "invalid_token",
  });
  // The bound defaults to sessionTtlSec, and must be a positive integer.
  await rejects(() => setup({ endSessionHintMaxAgeSec: 0 }), {
    name: "BoundsError",
  });
});

// DB-REV-JWT-3 (oidc): a client's registered keys are public metadata, so
// the provider never takes a symmetric key from them.

const HS_JWK = {
  kty: "oct",
  k: "c2VjcmV0LXNlY3JldC1zZWNyZXQtc2VjcmV0LXNlY3JldA",
  kid: "hs",
};

Deno.test("DB-REV-JWT-3: registration at the provider refuses an oct key in jwks", async () => {
  const { fetch } = await setup({ registration: {} });
  const { publicJwk } = await generateKeyPair("ES256", { kid: "one" });
  for (
    const keys of [[HS_JWK], [publicJwk, HS_JWK], [{ ...publicJwk, k: "AA" }]]
  ) {
    const answer = await fetch(`${OP}/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        redirect_uris: [CALLBACK],
        token_endpoint_auth_method: "private_key_jwt",
        jwks: { keys },
      }),
    });
    assertEquals(answer.status, 400);
    assertEquals((await answer.json()).error, "invalid_client_metadata");
  }
});

Deno.test("DB-REV-JWT-3: a client key set holding an oct key verifies no request object", async () => {
  const signer = await generateKeyPair("ES256", { kid: "app-key" });
  await rejects(() =>
    setup({
      clients: [{
        client_id: "signed-app",
        redirect_uris: [CALLBACK],
        jwks: { keys: [HS_JWK, signer.publicJwk] },
        token_endpoint_auth_method: "private_key_jwt",
      }],
    }), { code: "invalid_client_metadata" });
});

// Review F12, for clients: encryption keys in a client's jwks are skipped.
Deno.test("a client jwks with a public encryption key registers, and its request objects verify", async () => {
  const signer = await generateKeyPair("ES256", { kid: "app-key" });
  const enc = await generateKeyPair("ES256", { kid: "enc", extractable: true });
  const { alg: _alg, key_ops: _ops, ...encryption } = enc.publicJwk;
  const { key_ops: _privateOps, ext: _ext, ...privateEncryption } = await crypto
    .subtle.exportKey("jwk", enc.privateKey);
  const mixed = [
    { ...signer.publicJwk, use: "sig" },
    { ...encryption, alg: "ECDH-ES", use: "enc" },
  ];
  const { browser, time, fetch } = await setup({
    registration: {},
    clients: [{
      client_id: "signed-app",
      redirect_uris: [CALLBACK],
      jwks: { keys: mixed },
      token_endpoint_auth_method: "private_key_jwt",
    }],
  });
  const now = seconds(time.now);
  const object = (key: CryptoKey, kid: string, jti: string) =>
    sign(
      {
        iss: "signed-app",
        aud: OP,
        client_id: "signed-app",
        response_type: "code",
        redirect_uri: CALLBACK,
        scope: "openid",
        code_challenge: CHALLENGE,
        code_challenge_method: "S256",
        state: "ro",
        iat: now,
        exp: now + 60,
        jti,
      },
      key,
      { alg: "ES256", kid, typ: "oauth-authz-req+jwt" },
    );
  const go = (jwt: string) =>
    browser.request(`${OP}/authorize?client_id=signed-app&request=${jwt}`);
  const ok = await go(await object(signer.privateKey, "app-key", "m-1"));
  assertEquals(ok.status, 303, await ok.text());
  const underEnc = await go(await object(enc.privateKey, "enc", "m-2"));
  assertEquals(underEnc.status, 400, "the encryption key verifies nothing");

  const register = (keys: readonly unknown[]) =>
    fetch(`${OP}/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        redirect_uris: [CALLBACK],
        token_endpoint_auth_method: "private_key_jwt",
        jwks: { keys },
      }),
    });
  const registered = await register(mixed);
  assertEquals(registered.status, 201, await registered.clone().text());
  for (
    const keys of [
      [mixed[0], { ...privateEncryption, use: "enc" }],
      [mixed[0], { ...HS_JWK, alg: "A256KW", use: "enc" }],
      [mixed[1]],
    ]
  ) {
    const answer = await register(keys);
    assertEquals(answer.status, 400, JSON.stringify(keys));
    assertEquals((await answer.json()).error, "invalid_client_metadata");
  }
});

// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

import { assert, assertEquals } from "@celld/assert";
import { decode, generateKeyPair, sign } from "@celld/jwt";
import { tokenHash } from "@celld/oidc";
import type { OidcDecision } from "@celld/oidc/provider";
import { type LoginOptions, OidcClient } from "@celld/oidc/rp";
import {
  testBrowser,
  testProvider,
  type TestProviderOptions,
} from "@celld/oidc/testing";
import { DpopKey, DpopNonceIssuer } from "@celld/oauth/dpop";
import type { ClientAuthentication } from "@celld/oauth/client";
import { routeFetch } from "@celld/oauth/testing";
import { clock, json, rejects, seconds } from "./fixture.ts";

const OP = "https://op.test";
const APP = "https://app.test";
const CALLBACK = `${APP}/callback`;

async function setup(
  options: Partial<TestProviderOptions> = {},
  extraClients: TestProviderOptions["clients"] = [],
) {
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
        client_id: "signed-app",
        redirect_uris: [CALLBACK],
        jwks: { keys: [signer.publicJwk] },
        token_endpoint_auth_method: "private_key_jwt",
      },
      ...(extraClients ?? []),
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
  const login = async (client: OidcClient, login: LoginOptions = {}) => {
    const pending = await client.authorizationUrl(login);
    const callback = await browser.navigate(
      pending.authorization.url,
      CALLBACK,
    );
    return { pending, callback };
  };
  return { time, op, fetch, browser, rp, login, signer };
}

Deno.test("the OpenID configuration is served under the issuer, in both documents", async () => {
  const { op, fetch } = await setup();
  const document = await json(
    await fetch(`${OP}/.well-known/openid-configuration`),
  );
  assertEquals(document.issuer, OP);
  assertEquals(document.userinfo_endpoint, `${OP}/userinfo`);
  assertEquals(document.end_session_endpoint, `${OP}/end_session`);
  assertEquals(document.subject_types_supported, ["public"]);
  assertEquals(document.id_token_signing_alg_values_supported, ["ES256"]);
  assertEquals(document.claims_parameter_supported, true);
  assertEquals(document.request_parameter_supported, true);
  assert(
    (document.scopes_supported as string[]).includes("openid"),
    "openid is a scope",
  );
  assert(
    (document.dpop_signing_alg_values_supported as string[]).includes("ES256"),
    "DPoP algorithms",
  );
  const oauth = await json(
    await fetch(`${OP}/.well-known/oauth-authorization-server`),
  );
  assertEquals(oauth.userinfo_endpoint, `${OP}/userinfo`);
  assertEquals(
    op.provider.configurationPath,
    "/.well-known/openid-configuration",
  );
  const post = await fetch(`${OP}/.well-known/openid-configuration`, {
    method: "POST",
  });
  assertEquals(post.status, 405);
});

Deno.test("a login: code, PKCE, nonce, then a validated ID token with at_hash and sid", async () => {
  const { rp, login, op, time } = await setup();
  const client = rp();
  const { pending, callback } = await login(client, {
    scope: ["profile", "email"],
    maxAge: 600,
  });
  const url = new URL(pending.authorization.url);
  assertEquals(url.searchParams.get("request_uri")?.startsWith("urn:"), true);
  const done = await client.completeLogin(pending, callback);
  const claims = done.claims;
  assertEquals(claims.iss, OP);
  assertEquals(claims.aud, "app");
  assertEquals(claims.nonce, pending.nonce);
  assertEquals(claims.auth_time, seconds(time.now));
  assertEquals(
    claims.at_hash,
    await tokenHash(done.tokens.access_token, "ES256"),
  );
  assertEquals(claims.sid, await op.provider.sessionSid("session-1"));
  assertEquals(claims.name, undefined, "profile claims go to UserInfo");
  const access = decode(done.tokens.access_token).payload;
  assertEquals(access.aud, `${OP}/userinfo`);
  assertEquals(access.sid, claims.sid);
  const context = op.interactions[0];
  assertEquals(context.openid, true);
  assertEquals(context.maxAge, 600);
  assertEquals(context.needsLogin(seconds(time.now) - 601 - 10), true);
  assertEquals(context.needsLogin(seconds(time.now) - 5), false);
});

Deno.test("UserInfo answers the scopes' claims, Bearer and DPoP", async () => {
  const { rp, login, time } = await setup();
  const client = rp();
  const { pending, callback } = await login(client, { scope: ["email"] });
  const done = await client.completeLogin(pending, callback);
  assertEquals(await client.userinfo(done.tokens, done.subject), {
    email: "ada@example.com",
    email_verified: true,
    sub: "user-1",
  });
  const key = await DpopKey.generate({ now: time.now });
  const bound = rp({ dpop: key });
  const second = await login(bound, { scope: ["profile"] });
  const tokens = (await bound.completeLogin(second.pending, second.callback))
    .tokens;
  assertEquals(tokens.token_type, "DPoP");
  const profile = await bound.userinfo(tokens, "user-1");
  assertEquals(profile.name, "Ada Lovelace");
  assertEquals(profile.email, undefined);
});

Deno.test("UserInfo refusals: no token, a bound token as Bearer, no openid, revoked, another sub", async () => {
  const { rp, login, fetch, op, time } = await setup();
  const none = await fetch(`${OP}/userinfo`);
  assertEquals(none.status, 401);
  assert(
    none.headers.get("www-authenticate")!.includes("DPoP"),
    "the challenge names DPoP",
  );
  const key = await DpopKey.generate({ now: time.now });
  const bound = rp({ dpop: key });
  const { pending, callback } = await login(bound);
  const tokens = (await bound.completeLogin(pending, callback)).tokens;
  const asBearer = await fetch(`${OP}/userinfo`, {
    headers: { authorization: `Bearer ${tokens.access_token}` },
  });
  assertEquals(asBearer.status, 401);
  const client = rp();
  const plain = await login(client);
  const done = await client.completeLogin(plain.pending, plain.callback);
  await rejects(() => client.userinfo(done.tokens, "user-2"), { code: "sub" });
  const oauth = await client.oauth();
  await oauth.revoke(done.tokens.access_token);
  await rejects(() => client.userinfo(done.tokens, "user-1"), {
    kind: "token",
    error: "invalid_token",
  });
  const unscoped = await op.provider.server.verifyAccessToken(
    done.tokens.access_token,
  );
  assertEquals(unscoped, null, "revoked tokens do not verify");
});

Deno.test("the claims parameter adds ID token and UserInfo claims", async () => {
  const { rp, login } = await setup();
  const client = rp();
  const { pending, callback } = await login(client, {
    claims: {
      id_token: { email: { essential: true }, sub: null },
      userinfo: { phone_number: null },
    },
  });
  const done = await client.completeLogin(pending, callback);
  assertEquals(done.claims.email, "ada@example.com");
  assertEquals(done.claims.sub, "user-1");
  const info = await client.userinfo(done.tokens, "user-1");
  assertEquals(info, { phone_number: "+1 555 0100", sub: "user-1" });
});

Deno.test("prompt, max_age, acr and id_token_hint are enforced on the host's answer", async () => {
  let answer: OidcDecision | Response = { grant: { subject: "user-1" } };
  const { rp, login, time } = await setup({ consent: () => answer });
  const client = rp();
  const fails = async (options: LoginOptions, error: string) => {
    const { pending, callback } = await login(client, options);
    await rejects(() => client.completeLogin(pending, callback), {
      kind: "authorization",
      error,
    });
  };
  answer = { grant: { subject: "user-1", authTime: seconds(time.now) - 3600 } };
  await fails({ maxAge: 60 }, "login_required");
  answer = { grant: { subject: "user-1" } };
  await fails({ maxAge: 60 }, "login_required");
  await fails({ prompt: "login" }, "login_required");
  answer = new Response("login page");
  await fails({ prompt: "none" }, "interaction_required");
  answer = {
    grant: { subject: "user-1", authTime: seconds(time.now), acr: "urn:low" },
  };
  await fails({
    claims: { id_token: { acr: { essential: true, values: ["urn:high"] } } },
  }, "unmet_authentication_requirements");
  const first = await login(client);
  const hint = (await client.completeLogin(first.pending, first.callback))
    .idToken;
  answer = { grant: { subject: "user-2", authTime: seconds(time.now) } };
  await fails({ idTokenHint: hint }, "login_required");
  await fails({ idTokenHint: "not.a.token" }, "invalid_request");
  answer = {
    grant: { subject: "user-1", authTime: seconds(time.now), acr: "urn:high" },
  };
  const ok = await login(client, {
    claims: { id_token: { acr: { essential: true, values: ["urn:high"] } } },
  });
  const done = await client.completeLogin(ok.pending, ok.callback);
  assertEquals(done.claims.acr, "urn:high");
});

Deno.test("prompt none with other values is refused before the host sees it", async () => {
  const { op, fetch, browser } = await setup();
  const url = new URL(`${OP}/authorize`);
  const params = {
    response_type: "code",
    client_id: "app",
    redirect_uri: CALLBACK,
    scope: "openid",
    code_challenge: "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
    code_challenge_method: "S256",
    state: "s",
    prompt: "none login",
  };
  for (const [name, value] of Object.entries(params)) {
    url.searchParams.set(name, value);
  }
  const callback = new URL(await browser.navigate(url.href, CALLBACK));
  assertEquals(callback.searchParams.get("error"), "invalid_request");
  assertEquals(op.interactions.length, 0);
  assertEquals(fetch.requests.length, 1);
});

Deno.test("an interaction answered with a page resumes with the same checks", async () => {
  const { rp, op, time, browser } = await setup({
    consent: (context) =>
      new Response(null, {
        status: 303,
        headers: { location: `${OP}/login?i=${context.interactionId}` },
      }),
  });
  const client = rp();
  const pending = await client.authorizationUrl({ prompt: "login" });
  const page = await browser.navigate(pending.authorization.url, `${OP}/login`);
  const id = new URL(page).searchParams.get("i")!;
  const seen = await op.provider.interaction(id);
  assertEquals(seen?.prompt, ["login"]);
  const stale = await op.provider.resumeAuthorization(id, {
    grant: { subject: "user-1", authTime: seconds(time.now) - 3600 },
  });
  const location = new URL(stale.headers.get("location")!);
  assertEquals(location.searchParams.get("error"), "login_required");
  const again = await client.authorizationUrl({ prompt: "login" });
  const next = await browser.navigate(again.authorization.url, `${OP}/login`);
  time.advance(5_000);
  const fresh = await op.provider.resumeAuthorization(
    new URL(next).searchParams.get("i")!,
    { grant: { subject: "user-1", authTime: seconds(time.now) } },
  );
  const done = await client.completeLogin(
    again,
    fresh.headers.get("location")!,
  );
  assertEquals(done.subject, "user-1");
});

Deno.test("refresh: a new ID token for the same user and authentication, without a nonce", async () => {
  const { rp, login, time } = await setup();
  const client = rp();
  const { pending, callback } = await login(client);
  const first = await client.completeLogin(pending, callback);
  assert(first.tokens.refresh_token !== undefined, "a refresh token");
  time.advance(60_000);
  const refreshed = await client.refresh(
    first.tokens.refresh_token!,
    first.claims,
  );
  assertEquals(refreshed.claims?.sub, "user-1");
  assertEquals(refreshed.claims?.auth_time, first.claims.auth_time);
  assertEquals(refreshed.claims?.nonce, undefined);
  assertEquals(refreshed.claims?.iat, first.claims.iat + 60);
});

Deno.test("logout: end_session redirects to a registered URI and ends the session", async () => {
  const { rp, login, fetch } = await setup();
  const client = rp();
  const { pending, callback } = await login(client);
  const done = await client.completeLogin(pending, callback);
  const url = await client.logoutUrl({
    idTokenHint: done.idToken,
    postLogoutRedirectUri: `${APP}/bye`,
    state: "bye-state",
  });
  const response = await fetch(url, { redirect: "manual" });
  assertEquals(response.status, 303);
  assertEquals(
    response.headers.get("location"),
    `${APP}/bye?state=bye-state`,
  );
  await rejects(() => client.refresh(done.tokens.refresh_token!, done.claims), {
    kind: "token",
    error: "invalid_grant",
  });
  await rejects(() => client.userinfo(done.tokens, "user-1"), {
    error: "invalid_token",
  });
  const bad = await fetch(
    await client.logoutUrl({
      idTokenHint: done.idToken,
      postLogoutRedirectUri: "https://evil.test/",
    }),
  );
  assertEquals(bad.status, 400);
  const forged = await fetch(`${OP}/end_session?id_token_hint=a.b.c`);
  assertEquals(forged.status, 400);
  const plain = await fetch(`${OP}/end_session`);
  assertEquals(await plain.text(), "You are signed out.");
});

Deno.test("a logged-out session cannot sign in again", async () => {
  const { rp, login, op } = await setup();
  await op.provider.endLoginSession("session-1");
  const client = rp();
  const { pending, callback } = await login(client);
  await rejects(() => client.completeLogin(pending, callback), {
    error: "login_required",
  });
});

Deno.test("signed request objects: accepted once, from the client's keys, to this issuer", async () => {
  const { signer, browser, time } = await setup();
  const iat = seconds(time.now);
  const object = (claims: Record<string, unknown>) =>
    sign(
      {
        iss: "signed-app",
        aud: OP,
        client_id: "signed-app",
        response_type: "code",
        redirect_uri: CALLBACK,
        scope: "openid",
        code_challenge: "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
        code_challenge_method: "S256",
        state: "ro",
        nonce: "ro-nonce",
        claims: { id_token: { email: null } },
        iat,
        exp: iat + 60,
        jti: "jti-1",
        ...claims,
      },
      signer.privateKey,
      { alg: "ES256", kid: "app-key", typ: "oauth-authz-req+jwt" },
    );
  const go = async (jwt: string) => {
    const url = `${OP}/authorize?client_id=signed-app&request=${jwt}`;
    const response = await browser.request(url);
    return response;
  };
  const ok = await go(await object({}));
  assertEquals(ok.status, 303);
  const location = new URL(ok.headers.get("location")!);
  assertEquals(location.searchParams.get("state"), "ro");
  assert(location.searchParams.has("code"), "a code");
  const replay = await go(await object({}));
  assertEquals(replay.status, 400);
  assert((await replay.text()).includes("used before"), "replay");
  const withSub = await go(await object({ jti: "jti-2", sub: "signed-app" }));
  assertEquals(withSub.status, 400);
  const elsewhere = await go(
    await object({ jti: "jti-3", aud: "https://other.test" }),
  );
  assertEquals(elsewhere.status, 400);
  const other = await generateKeyPair("ES256", { kid: "app-key" });
  const forged = await sign(
    {
      iss: "signed-app",
      aud: OP,
      exp: iat + 60,
      jti: "jti-4",
    },
    other.privateKey,
    { alg: "ES256", kid: "app-key" },
  );
  assertEquals((await go(forged)).status, 400);
});

Deno.test("DPoP nonces at the token endpoint and at UserInfo are both followed", async () => {
  const time = clock();
  const nonce = await DpopNonceIssuer.create({ now: time.now });
  const { rp, login, fetch } = await setup({ dpop: { nonce }, now: time.now });
  const key = await DpopKey.generate({ now: time.now });
  const client = rp({ dpop: key, now: time.now });
  const { pending, callback } = await login(client, { scope: ["email"] });
  const done = await client.completeLogin(pending, callback);
  assertEquals(done.tokens.token_type, "DPoP");
  const before = fetch.requests.length;
  const info = await client.userinfo(done.tokens, "user-1");
  assertEquals(info.email, "ada@example.com");
  const tries = fetch.requests.slice(before);
  assertEquals(tries.length, 2, "one refusal for the nonce, then the answer");
  assert(
    decode(tries[1].headers.get("dpop")!).payload.nonce !== undefined,
    "the retry carries the nonce",
  );
});

Deno.test("UserInfo's challenge names resource metadata the provider serves", async () => {
  const { fetch } = await setup();
  const challenge = (await fetch(`${OP}/userinfo`)).headers.get(
    "www-authenticate",
  )!;
  const url = /resource_metadata="([^"]+)"/.exec(challenge)![1];
  assertEquals(url, `${OP}/.well-known/oauth-protected-resource/userinfo`);
  const document = await json(await fetch(url));
  assertEquals(document.resource, `${OP}/userinfo`);
  assertEquals(document.authorization_servers, [OP]);
});

Deno.test("prompt=login is never met by a session from before the request", async () => {
  let answer: OidcDecision = { grant: { subject: "user-1" } };
  const { rp, login, time, op } = await setup({ consent: () => answer });
  const client = rp();
  answer = { grant: { subject: "user-1", authTime: seconds(time.now) - 5 } };
  const stale = await login(client, { prompt: "login" });
  await rejects(() => client.completeLogin(stale.pending, stale.callback), {
    error: "login_required",
  });
  const context = op.interactions.at(-1)!;
  assertEquals(context.needsLogin(seconds(time.now)), true);
  answer = { grant: { subject: "user-1", authTime: seconds(time.now) } };
  const fresh = await login(client, { prompt: "login" });
  const done = await client.completeLogin(fresh.pending, fresh.callback);
  assertEquals(done.claims.auth_time, seconds(time.now));
});

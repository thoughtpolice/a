// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

import { assert, assertEquals } from "@celld/assert";
import { decode, sign, verify } from "@celld/jwt";
import { JWT_BEARER_ASSERTION, pkcePair } from "@celld/oauth";
import { DpopKey, DpopNonceIssuer } from "@celld/oauth/dpop";
import { publicJwks } from "@celld/oauth/server";
import {
  API,
  authorize,
  body,
  ISSUER,
  oauthError,
  OTHER_API,
  post,
  redeem,
  RS_AUTH,
  SECRET,
  tokenProof,
  WEB_AUTH,
  type World,
  world,
} from "./fixture.ts";

async function accessClaims(w: World, token: string) {
  return (await verify(token, publicJwks(w.keys), {
    typ: "at+jwt",
    issuer: ISSUER,
    now: w.clock.now,
  })).payload;
}

async function introspect(w: World, token: string) {
  return await body(
    await w.handle(
      post(w.server.endpoint("introspection"), { token }, RS_AUTH),
    ),
  );
}

Deno.test("metadata: RFC 8414 with the registered extensions", async () => {
  const w = await world({ registration: {}, clientIdMetadataDocuments: {} });
  const response = await w.handle(
    new Request(`${ISSUER}/.well-known/oauth-authorization-server`),
  );
  assertEquals(response.status, 200);
  const metadata = await body(response);
  assertEquals(metadata.issuer, ISSUER);
  assertEquals(metadata.token_endpoint, `${ISSUER}/token`);
  assertEquals(metadata.code_challenge_methods_supported, ["S256"]);
  assertEquals(metadata.response_types_supported, ["code"]);
  assertEquals(metadata.authorization_response_iss_parameter_supported, true);
  assertEquals(metadata.registration_endpoint, `${ISSUER}/register`);
  assertEquals(metadata.client_id_metadata_document_supported, true);
  assertEquals(metadata.pushed_authorization_request_endpoint, `${ISSUER}/par`);
  assertEquals(
    metadata.device_authorization_endpoint,
    `${ISSUER}/device_authorization`,
  );
  assert(
    (metadata.dpop_signing_alg_values_supported as string[]).includes("ES256"),
    "DPoP algorithms are listed",
  );
  assert(
    !(metadata.dpop_signing_alg_values_supported as string[]).includes("EdDSA"),
    "EdDSA is not, by default",
  );
  assertEquals(
    (await w.handle(
      new Request(`${ISSUER}/.well-known/oauth-authorization-server`, {
        method: "POST",
      }),
    )).status,
    405,
  );
  const jwks = await body(await w.handle(new Request(`${ISSUER}/jwks`)));
  assertEquals((jwks.keys as unknown[]).length, 1);
  assert(
    !("d" in (jwks.keys as Record<string, unknown>[])[0]),
    "public keys only",
  );
  assertEquals(await w.server.handle(new Request(`${ISSUER}/elsewhere`)), null);
});

Deno.test("metadata: an issuer with a path puts it after the well-known suffix", async () => {
  const w = await world({ issuer: "https://as.test/tenant-1" });
  assertEquals(
    w.server.metadataPath,
    "/.well-known/oauth-authorization-server/tenant-1",
  );
  assertEquals(w.server.endpoint("token"), "https://as.test/tenant-1/token");
});

Deno.test("authorize: errors before the redirect URI is trusted are never redirected", async () => {
  const w = await world();
  const unknown = await authorize(w, "nobody");
  assertEquals(unknown.response.status, 400);
  assertEquals(unknown.location, null);
  const badRedirect = await authorize(w, "public-app", {
    redirect_uri: "https://evil.test/cb",
  });
  assertEquals(badRedirect.response.status, 400);
  assertEquals(badRedirect.location, null);
  // Two redirect URIs are registered, so the parameter is required.
  const url = new URL(w.server.endpoint("authorization"));
  url.searchParams.set("client_id", "public-app");
  url.searchParams.set("response_type", "code");
  assertEquals((await w.handle(new Request(url))).status, 400);
  // Prefix and case variations are not the registered URI.
  for (
    const uri of [
      "https://app.test/cb/",
      "https://APP.test/cb",
      "https://app.test/cb?x=1",
    ]
  ) {
    const result = await authorize(w, "public-app", { redirect_uri: uri });
    assertEquals(result.response.status, 400, uri);
  }
});

Deno.test("authorize: loopback IP redirect URIs may use any port, localhost may not", async () => {
  const w = await world();
  const ok = await authorize(w, "public-app", {
    redirect_uri: "http://127.0.0.1:49152/cb",
  });
  assertEquals(ok.response.status, 303);
  assertEquals(ok.location?.origin, "http://127.0.0.1:49152");
  const path = await authorize(w, "public-app", {
    redirect_uri: "http://127.0.0.1:49152/other",
  });
  assertEquals(path.response.status, 400);
  const localhost = await authorize(w, "public-app", {
    redirect_uri: "http://localhost:49152/cb",
  });
  assertEquals(localhost.response.status, 400);
});

Deno.test("authorize: errors after it go back with state and iss (RFC 9207)", async () => {
  const w = await world();
  const cases: [Record<string, string>, string][] = [
    [{ code_challenge_method: "plain" }, "invalid_request"],
    [{ code_challenge: "" }, "invalid_request"],
    [{ code_challenge: "short" }, "invalid_request"],
    [{ response_type: "token" }, "unsupported_response_type"],
    [{ scope: "read nonsense" }, "invalid_scope"],
    [{ resource: "https://unlisted.test" }, "invalid_target"],
    [{ resource: "http://api.test" }, "invalid_target"],
    [{ response_mode: "fragment" }, "invalid_request"],
    [{ dpop_jkt: "not-a-thumbprint" }, "invalid_request"],
    [{ request: "a.b.c" }, "request_not_supported"],
  ];
  for (const [params, error] of cases) {
    const result = await authorize(w, "public-app", params);
    assertEquals(result.response.status, 303, JSON.stringify(params));
    assertEquals(
      result.location?.searchParams.get("error"),
      error,
      JSON.stringify(params),
    );
    assertEquals(result.location?.searchParams.get("state"), "state-1");
    assertEquals(result.location?.searchParams.get("iss"), ISSUER);
    assertEquals(result.code, null);
  }
  // No resource and no default: every token names its audience.
  const url = new URL(w.server.endpoint("authorization"));
  const pkce = await pkcePair();
  for (
    const [name, value] of Object.entries({
      client_id: "public-app",
      redirect_uri: "https://app.test/cb",
      response_type: "code",
      code_challenge: pkce.challenge,
      code_challenge_method: "S256",
    })
  ) url.searchParams.set(name, value);
  const none = await w.handle(new Request(url));
  assertEquals(
    new URL(none.headers.get("location")!).searchParams.get("error"),
    "invalid_target",
  );
});

Deno.test("code grant: RFC 9068 access tokens for the requested resource", async () => {
  const w = await world();
  const authorized = await authorize(w, "public-app", { scope: "read write" });
  assertEquals(authorized.response.status, 303);
  assertEquals(authorized.location?.searchParams.get("iss"), ISSUER);
  assertEquals(authorized.location?.searchParams.get("state"), "state-1");
  assertEquals(w.interactions[0].scope, ["read", "write"]);
  assertEquals(w.interactions[0].resource, [API]);
  const response = await redeem(w, authorized);
  assertEquals(response.status, 200);
  assertEquals(response.headers.get("cache-control"), "no-store");
  const tokens = await body(response);
  assertEquals(tokens.token_type, "Bearer");
  assertEquals(tokens.expires_in, 300);
  assertEquals(tokens.scope, "read write");
  assert(typeof tokens.refresh_token === "string", "a refresh token");
  const { header } = decode(tokens.access_token as string);
  assertEquals(header.typ, "at+jwt");
  assertEquals(header.kid, "test-key");
  const claims = await accessClaims(w, tokens.access_token as string);
  assertEquals(claims.iss, ISSUER);
  assertEquals(claims.sub, "user-1");
  assertEquals(claims.aud, API);
  assertEquals(claims.client_id, "public-app");
  assertEquals(claims.scope, "read write");
  assertEquals(claims.exp, (claims.iat as number) + 300);
  assert(typeof claims.jti === "string", "jti");
  assertEquals(claims.cnf, undefined);
});

Deno.test("code grant: PKCE, redirect URI, client and expiry are all checked", async () => {
  const w = await world();
  const wrongVerifier = await authorize(w, "public-app");
  await oauthError(
    await redeem(w, wrongVerifier, { code_verifier: "x".repeat(43) }),
    400,
    "invalid_grant",
  );
  const wrongRedirect = await authorize(w, "public-app");
  await oauthError(
    await redeem(w, wrongRedirect, { redirect_uri: "http://127.0.0.1/cb" }),
    400,
    "invalid_grant",
  );
  const otherClient = await authorize(w, "public-app");
  await oauthError(
    await redeem(w, otherClient, {
      client_id: "post-app",
      client_secret: SECRET,
    }),
    400,
    "invalid_grant",
  );
  const expired = await authorize(w, "public-app");
  w.clock.advance(61_000);
  await oauthError(await redeem(w, expired), 400, "invalid_grant");
  const narrower = await authorize(w, "public-app", {
    resource: [API, OTHER_API],
  });
  const response = await redeem(w, narrower, { resource: OTHER_API });
  assertEquals(response.status, 200);
  assertEquals(
    (await accessClaims(w, (await body(response)).access_token as string)).aud,
    OTHER_API,
  );
  const wider = await authorize(w, "public-app");
  await oauthError(
    await redeem(w, wider, { resource: OTHER_API }),
    400,
    "invalid_target",
  );
});

Deno.test("code grant: a reused code revokes what the first use issued", async () => {
  const w = await world();
  const authorized = await authorize(w, "public-app");
  const first = await body(await redeem(w, authorized));
  assertEquals(
    (await introspect(w, first.access_token as string)).active,
    true,
  );
  // Long after the code itself expired, a replay still revokes.
  w.clock.advance(120_000);
  await oauthError(await redeem(w, authorized), 400, "invalid_grant");
  assertEquals(
    (await introspect(w, first.access_token as string)).active,
    false,
  );
  await oauthError(
    await w.handle(post(w.server.endpoint("token"), {
      grant_type: "refresh_token",
      refresh_token: first.refresh_token as string,
      client_id: "public-app",
    })),
    400,
    "invalid_grant",
  );
});

async function refresh(
  w: World,
  token: string,
  extra: Record<string, string> = {},
  headers: Record<string, string> = {},
) {
  return await w.handle(post(w.server.endpoint("token"), {
    grant_type: "refresh_token",
    refresh_token: token,
    client_id: "public-app",
    ...extra,
  }, headers));
}

Deno.test("refresh: rotation, and reuse revokes the family", async () => {
  const w = await world();
  const first = await body(
    await redeem(w, await authorize(w, "public-app", { scope: "read write" })),
  );
  const second = await body(await refresh(w, first.refresh_token as string));
  assert(second.refresh_token !== first.refresh_token, "the token rotates");
  const narrowed = await body(
    await refresh(w, second.refresh_token as string, { scope: "read" }),
  );
  assertEquals(narrowed.scope, "read");
  await oauthError(
    await refresh(w, narrowed.refresh_token as string, { scope: "admin" }),
    400,
    "invalid_scope",
  );
  const current = narrowed.refresh_token as string;
  // An old token comes back: the whole family goes.
  await oauthError(
    await refresh(w, first.refresh_token as string),
    400,
    "invalid_grant",
  );
  await oauthError(await refresh(w, current), 400, "invalid_grant");
  // A made-up token of a live family does not revoke it.
  const fresh = await body(await redeem(w, await authorize(w, "public-app")));
  const family = (fresh.refresh_token as string).split(".")[0];
  await oauthError(
    await refresh(w, `${family}.${"A".repeat(43)}`),
    400,
    "invalid_grant",
  );
  assertEquals((await refresh(w, fresh.refresh_token as string)).status, 200);
});

Deno.test("refresh: idle and absolute lifetimes", async () => {
  const w = await world({ refreshIdleTtlSec: 100, refreshTokenTtlSec: 250 });
  const tokens = await body(await redeem(w, await authorize(w, "public-app")));
  w.clock.advance(90_000);
  const a = await body(await refresh(w, tokens.refresh_token as string));
  w.clock.advance(90_000);
  const b = await body(await refresh(w, a.refresh_token as string));
  w.clock.advance(90_000);
  await oauthError(
    await refresh(w, b.refresh_token as string),
    400,
    "invalid_grant",
  );
  const idle = await body(await redeem(w, await authorize(w, "public-app")));
  w.clock.advance(101_000);
  await oauthError(
    await refresh(w, idle.refresh_token as string),
    400,
    "invalid_grant",
  );
});

Deno.test("client authentication: methods, secrets and downgrades", async () => {
  const w = await world();
  const token = w.server.endpoint("token");
  const grant = { grant_type: "client_credentials", resource: API };
  assertEquals((await w.handle(post(token, grant, WEB_AUTH))).status, 200);
  const wrong = await w.handle(post(token, grant, {
    authorization: `Basic ${btoa("web-app:nope")}`,
  }));
  await oauthError(wrong, 401, "invalid_client");
  assertEquals(wrong.headers.get("www-authenticate"), 'Basic realm="oauth"');
  // web-app is registered for client_secret_basic; the body form is refused.
  await oauthError(
    await w.handle(
      post(token, { ...grant, client_id: "web-app", client_secret: SECRET }),
    ),
    401,
    "invalid_client",
  );
  // A confidential client cannot drop to `none`.
  await oauthError(
    await w.handle(post(token, { ...grant, client_id: "web-app" })),
    401,
    "invalid_client",
  );
  // Two methods at once.
  await oauthError(
    await w.handle(post(token, { ...grant, client_secret: SECRET }, WEB_AUTH)),
    400,
    "invalid_request",
  );
  assertEquals(
    (await w.handle(
      post(token, { ...grant, client_id: "post-app", client_secret: SECRET }),
    )).status,
    200,
  );
  await oauthError(await w.handle(post(token, grant)), 401, "invalid_client");
  await oauthError(
    await w.handle(post(token, { ...grant, client_id: "nobody" })),
    401,
    "invalid_client",
  );
  // A public client may not use client credentials.
  await oauthError(
    await w.handle(post(token, { ...grant, client_id: "public-app" })),
    400,
    "unauthorized_client",
  );
  await oauthError(
    await w.handle(
      post(
        token,
        { grant_type: "password", username: "u", password: "p" },
        WEB_AUTH,
      ),
    ),
    400,
    "unsupported_grant_type",
  );
  const bad = await w.handle(
    new Request(token, {
      method: "POST",
      body: "{}",
      headers: { "content-type": "application/json" },
    }),
  );
  await oauthError(bad, 400, "invalid_request");
});

Deno.test("private_key_jwt: signed by the client's key for this issuer, used once", async () => {
  const w = await world();
  const token = w.server.endpoint("token");
  const now = Math.floor(w.clock.now() / 1000);
  const assertion = async (claims: Record<string, unknown> = {}) =>
    await sign(
      {
        iss: "jwt-app",
        sub: "jwt-app",
        aud: ISSUER,
        jti: crypto.randomUUID(),
        iat: now,
        exp: now + 60,
        ...claims,
      },
      w.clientKey.privateKey,
      { alg: "ES256", kid: "jwt-app-1" },
    );
  const request = (value: string) =>
    post(token, {
      grant_type: "client_credentials",
      resource: API,
      client_assertion_type: JWT_BEARER_ASSERTION,
      client_assertion: value,
    });
  const once = await assertion();
  const ok = await w.handle(request(once));
  assertEquals(ok.status, 200);
  assertEquals(
    (await accessClaims(w, (await body(ok)).access_token as string)).sub,
    "jwt-app",
  );
  await oauthError(await w.handle(request(once)), 401, "invalid_client");
  await oauthError(
    await w.handle(request(await assertion({ aud: token }))),
    401,
    "invalid_client",
  );
  await oauthError(
    await w.handle(request(await assertion({ exp: now + 3600 }))),
    401,
    "invalid_client",
  );
  await oauthError(
    await w.handle(request(await assertion({ sub: "other" }))),
    401,
    "invalid_client",
  );
  const legacy = await world({ legacyAssertionAudience: true });
  const legacyAssertion = await sign(
    {
      iss: "jwt-app",
      sub: "jwt-app",
      aud: legacy.server.endpoint("token"),
      jti: "j",
    },
    legacy.clientKey.privateKey,
    {
      alg: "ES256",
      expiresIn: 60,
      now: legacy.clock.now,
    },
  );
  assertEquals((await legacy.handle(request(legacyAssertion))).status, 200);
});

Deno.test("client credentials: confidential clients, their scopes, a resource", async () => {
  const w = await world({}, [{
    client_id: "narrow",
    client_secret: SECRET,
    scope: "read",
    grant_types: ["client_credentials"],
  }]);
  const token = w.server.endpoint("token");
  const narrow = { authorization: `Basic ${btoa(`narrow:${SECRET}`)}` };
  const ok = await body(
    await w.handle(post(token, {
      grant_type: "client_credentials",
      scope: "read",
      resource: API,
    }, narrow)),
  );
  assertEquals(ok.refresh_token, undefined);
  assertEquals(
    (await accessClaims(w, ok.access_token as string)).sub,
    "narrow",
  );
  await oauthError(
    await w.handle(
      post(token, {
        grant_type: "client_credentials",
        scope: "write",
        resource: API,
      }, narrow),
    ),
    400,
    "invalid_scope",
  );
  await oauthError(
    await w.handle(post(token, { grant_type: "client_credentials" }, narrow)),
    400,
    "invalid_target",
  );
  const defaulted = await world({
    resources: { allowed: [API], default: [API] },
  });
  assertEquals(
    (await defaulted.handle(
      post(token, { grant_type: "client_credentials" }, WEB_AUTH),
    )).status,
    200,
  );
});

Deno.test("PAR: pushed requests, used once, and required when configured", async () => {
  const w = await world();
  const pkce = await pkcePair();
  const params = {
    response_type: "code",
    client_id: "web-app",
    redirect_uri: "https://web.test/cb",
    code_challenge: pkce.challenge,
    code_challenge_method: "S256",
    state: "s",
    scope: "read",
    resource: API,
  };
  const pushed = await w.handle(
    post(w.server.endpoint("par"), params, WEB_AUTH),
  );
  assertEquals(pushed.status, 201);
  const { request_uri, expires_in } = await body(pushed);
  assertEquals(expires_in, 60);
  assert(
    String(request_uri).startsWith("urn:ietf:params:oauth:request_uri:"),
    "a URN",
  );
  const url = new URL(w.server.endpoint("authorization"));
  url.searchParams.set("client_id", "web-app");
  url.searchParams.set("request_uri", String(request_uri));
  const first = await w.handle(new Request(url));
  assertEquals(first.status, 303);
  const code = new URL(first.headers.get("location")!).searchParams.get(
    "code",
  )!;
  assert(code !== null, "a code");
  assertEquals((await w.handle(new Request(url))).status, 400);
  const redeemed = await w.handle(post(w.server.endpoint("token"), {
    grant_type: "authorization_code",
    code,
    code_verifier: pkce.verifier,
    redirect_uri: "https://web.test/cb",
  }, WEB_AUTH));
  assertEquals(redeemed.status, 200);
  // Pushing needs client authentication, and validates like authorize.
  await oauthError(
    await w.handle(
      post(w.server.endpoint("par"), { ...params, client_id: "web-app" }),
    ),
    401,
    "invalid_client",
  );
  await oauthError(
    await w.handle(
      post(w.server.endpoint("par"), {
        ...params,
        code_challenge_method: "plain",
      }, WEB_AUTH),
    ),
    400,
    "invalid_request",
  );
  // Another client cannot use it.
  const other = await body(
    await w.handle(post(w.server.endpoint("par"), params, WEB_AUTH)),
  );
  const stolen = new URL(w.server.endpoint("authorization"));
  stolen.searchParams.set("client_id", "public-app");
  stolen.searchParams.set("request_uri", String(other.request_uri));
  assertEquals((await w.handle(new Request(stolen))).status, 400);
  // Expired.
  const late = await body(
    await w.handle(post(w.server.endpoint("par"), params, WEB_AUTH)),
  );
  w.clock.advance(61_000);
  url.searchParams.set("request_uri", String(late.request_uri));
  assertEquals((await w.handle(new Request(url))).status, 400);

  const strict = await world({ requirePar: true });
  const direct = await authorize(strict, "web-app");
  assertEquals(direct.location?.searchParams.get("error"), "invalid_request");
  const metadata = await body(
    await strict.handle(
      new Request(`${ISSUER}/.well-known/oauth-authorization-server`),
    ),
  );
  assertEquals(metadata.require_pushed_authorization_requests, true);
});

Deno.test("interaction: a host page, then resumeAuthorization", async () => {
  let seen = "";
  const w = await world({
    consent: (context) => {
      seen = context.interactionId;
      return Response.redirect(
        `${ISSUER}/login?i=${context.interactionId}`,
        303,
      );
    },
  });
  const started = await authorize(w, "public-app", { prompt: "login" });
  assertEquals(started.location?.pathname, "/login");
  const pending = await w.server.interaction(seen);
  assertEquals(pending?.client.client_id, "public-app");
  assertEquals(pending?.params.prompt, "login");
  const done = await w.server.resumeAuthorization(seen, {
    grant: { subject: "alice", scope: ["read", "admin"] },
  });
  const location = new URL(done.headers.get("location")!);
  assertEquals(location.searchParams.get("iss"), ISSUER);
  assertEquals(location.searchParams.get("state"), "state-1");
  const code = location.searchParams.get("code")!;
  const tokens = await body(await redeem(w, { ...started, code }));
  const claims = await accessClaims(w, tokens.access_token as string);
  assertEquals(claims.sub, "alice");
  // The grant cannot add scopes that were not asked for.
  assertEquals(claims.scope, "read");
  assertEquals(
    (await w.server.resumeAuthorization(seen, { grant: { subject: "bob" } }))
      .status,
    400,
  );
  assertEquals(await w.server.interaction(seen), null);

  const denied = await world({
    consent: () => ({ deny: { error: "login_required" } }),
  });
  const refused = await authorize(denied, "public-app");
  assertEquals(refused.location?.searchParams.get("error"), "login_required");
  assertEquals(refused.location?.searchParams.get("iss"), ISSUER);
});

Deno.test("DPoP: bound codes, bound tokens, bound public refresh tokens", async () => {
  const w = await world();
  const key = await DpopKey.generate({ now: w.clock.now });
  const other = await DpopKey.generate({ now: w.clock.now });
  const authorized = await authorize(w, "public-app", { dpop_jkt: key.jkt });
  await oauthError(await redeem(w, authorized), 400, "invalid_dpop_proof");
  const againAuthorized = await authorize(w, "public-app", {
    dpop_jkt: key.jkt,
  });
  await oauthError(
    await redeem(w, againAuthorized, {}, await tokenProof(w, other)),
    400,
    "invalid_dpop_proof",
  );
  const bound = await authorize(w, "public-app", { dpop_jkt: key.jkt });
  const response = await redeem(w, bound, {}, await tokenProof(w, key));
  assertEquals(response.status, 200);
  const tokens = await body(response);
  assertEquals(tokens.token_type, "DPoP");
  assertEquals((await accessClaims(w, tokens.access_token as string)).cnf, {
    jkt: key.jkt,
  });
  const introspected = await introspect(w, tokens.access_token as string);
  assertEquals(introspected.token_type, "DPoP");
  assertEquals(introspected.cnf, { jkt: key.jkt });
  // The public client's refresh token is bound to the key.
  await oauthError(
    await refresh(w, tokens.refresh_token as string),
    400,
    "invalid_dpop_proof",
  );
  await oauthError(
    await refresh(
      w,
      tokens.refresh_token as string,
      {},
      await tokenProof(w, other),
    ),
    400,
    "invalid_dpop_proof",
  );
  const refreshed = await refresh(
    w,
    tokens.refresh_token as string,
    {},
    await tokenProof(w, key),
  );
  assertEquals(refreshed.status, 200);
  assertEquals((await body(refreshed)).token_type, "DPoP");
  // A proof is used once.
  const proof = await tokenProof(w, key);
  const code = await authorize(w, "public-app");
  assertEquals((await redeem(w, code, {}, proof)).status, 200);
  const code2 = await authorize(w, "public-app");
  await oauthError(
    await redeem(w, code2, {}, proof),
    400,
    "invalid_dpop_proof",
  );
  // A proof for another URL.
  const code3 = await authorize(w, "public-app");
  await oauthError(
    await redeem(w, code3, {}, {
      dpop: await key.proof({
        method: "POST",
        url: `${ISSUER}/elsewhere`,
        now: w.clock.now,
      }),
    }),
    400,
    "invalid_dpop_proof",
  );
});

Deno.test("DPoP: confidential refresh tokens are not bound; bound clients must prove", async () => {
  const w = await world();
  const key = await DpopKey.generate({ now: w.clock.now });
  const authorized = await authorize(w, "web-app");
  const tokens = await body(
    await redeem(w, authorized, {
      client_id: "web-app",
      redirect_uri: "https://web.test/cb",
    }, { ...WEB_AUTH, ...(await tokenProof(w, key)) }),
  );
  assertEquals(tokens.token_type, "DPoP");
  const refreshed = await w.handle(post(w.server.endpoint("token"), {
    grant_type: "refresh_token",
    refresh_token: tokens.refresh_token as string,
  }, WEB_AUTH));
  assertEquals(refreshed.status, 200);
  assertEquals((await body(refreshed)).token_type, "Bearer");
  const boundApp = await authorize(w, "bound-app");
  await oauthError(
    await redeem(w, boundApp, {
      client_id: "bound-app",
      redirect_uri: "https://bound.test/cb",
    }),
    400,
    "invalid_dpop_proof",
  );
});

Deno.test("DPoP: server nonces at the token endpoint", async () => {
  const nonce = await DpopNonceIssuer.create({ lifetimeSec: 60 });
  const w = await world({ dpop: { nonce } });
  const key = await DpopKey.generate({ now: w.clock.now });
  const authorized = await authorize(w, "public-app");
  const first = await redeem(w, authorized, {}, await tokenProof(w, key));
  await oauthError(first, 400, "use_dpop_nonce");
  const fresh = first.headers.get("dpop-nonce")!;
  assert(await nonce.check(fresh), "the answer carries a nonce");
  const second = await redeem(
    w,
    authorized,
    {},
    await tokenProof(w, key, fresh),
  );
  assertEquals(second.status, 200);
  assert(
    second.headers.get("dpop-nonce") !== null,
    "success carries the nonce too",
  );
});

Deno.test("registration: off by default; validated; secrets stored as hashes", async () => {
  const off = await world();
  const register = (
    w: World,
    metadata: unknown,
    headers: Record<string, string> = {},
  ) =>
    w.handle(
      new Request(w.server.endpoint("registration"), {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body: JSON.stringify(metadata),
      }),
    );
  assertEquals(
    (await register(off, { redirect_uris: ["https://x.test/cb"] })).status,
    404,
  );

  const w = await world({ registration: { initialAccessToken: "iat-123" } });
  const good = {
    client_name: "Tool",
    redirect_uris: ["http://127.0.0.1/callback"],
    application_type: "native",
    token_endpoint_auth_method: "none",
    grant_types: ["authorization_code", "refresh_token"],
  };
  await oauthError(await register(w, good), 401, "invalid_token");
  const auth = { authorization: "Bearer iat-123" };
  const created = await register(w, good, auth);
  assertEquals(created.status, 201);
  const client = await body(created);
  assertEquals(client.client_secret, undefined);
  assertEquals(client.token_endpoint_auth_method, "none");
  const pkce = await pkcePair();
  const url = new URL(w.server.endpoint("authorization"));
  for (
    const [name, value] of Object.entries({
      client_id: client.client_id as string,
      redirect_uri: "http://127.0.0.1:5000/callback",
      response_type: "code",
      code_challenge: pkce.challenge,
      code_challenge_method: "S256",
      resource: API,
    })
  ) url.searchParams.set(name, value);
  assertEquals((await w.handle(new Request(url))).status, 303);

  const confidential = await body(
    await register(w, {
      redirect_uris: ["https://svc.test/cb"],
      grant_types: ["authorization_code", "client_credentials"],
    }, auth),
  );
  assertEquals(confidential.token_endpoint_auth_method, "client_secret_basic");
  assert(typeof confidential.client_secret === "string", "a secret is issued");
  const stored = await w.store.get<Record<string, unknown>>(
    `client:${confidential.client_id}`,
  );
  assertEquals(stored?.value.client_secret, undefined);
  assert(
    typeof stored?.value.client_secret_hash === "string",
    "only the hash is kept",
  );
  const cc = await w.handle(post(w.server.endpoint("token"), {
    grant_type: "client_credentials",
    resource: API,
  }, {
    authorization: `Basic ${
      btoa(`${confidential.client_id}:${confidential.client_secret}`)
    }`,
  }));
  assertEquals(cc.status, 200);

  const bad: [unknown, string][] = [
    [{ redirect_uris: ["http://evil.test/cb"] }, "invalid_redirect_uri"],
    [{ redirect_uris: ["javascript:alert(1)"] }, "invalid_redirect_uri"],
    [{ redirect_uris: ["https://x.test/cb#frag"] }, "invalid_redirect_uri"],
    [
      { redirect_uris: ["myapp:/cb"], application_type: "native" },
      "invalid_redirect_uri",
    ],
    [{ redirect_uris: ["com.example.app:/cb"] }, "invalid_redirect_uri"],
    [{}, "invalid_redirect_uri"],
    [
      { redirect_uris: ["https://x.test/cb"], grant_types: ["password"] },
      "invalid_client_metadata",
    ],
    [
      { redirect_uris: ["https://x.test/cb"], response_types: ["token"] },
      "invalid_client_metadata",
    ],
    [{
      redirect_uris: ["https://x.test/cb"],
      token_endpoint_auth_method: "tls_client_auth",
    }, "invalid_client_metadata"],
    [{
      redirect_uris: ["https://x.test/cb"],
      token_endpoint_auth_method: "private_key_jwt",
    }, "invalid_client_metadata"],
    [
      { redirect_uris: ["https://x.test/cb"], scope: "read nonsense" },
      "invalid_client_metadata",
    ],
    [{ redirect_uris: "https://x.test/cb" }, "invalid_client_metadata"],
    [{
      redirect_uris: ["https://x.test/cb"],
      logo_uri: "http://x.test/logo.png",
    }, "invalid_client_metadata"],
  ];
  for (const [metadata, error] of bad) {
    await oauthError(await register(w, metadata, auth), 400, error);
  }
  const native = await register(w, {
    redirect_uris: ["com.example.app:/cb"],
    application_type: "native",
    token_endpoint_auth_method: "none",
  }, auth);
  assertEquals(native.status, 201);
});

Deno.test("Client ID Metadata Documents: fetched, checked, cached", async () => {
  const documentUrl = "https://tool.test/oauth/client.json";
  let served: Record<string, unknown> = {
    client_id: documentUrl,
    client_name: "Tool",
    redirect_uris: ["http://127.0.0.1/cb"],
    token_endpoint_auth_method: "none",
  };
  let fetches = 0;
  const w = await world({
    clientIdMetadataDocuments: { cacheSec: 60 },
    fetch: (input) => {
      fetches++;
      assertEquals(
        String(input instanceof Request ? input.url : input),
        documentUrl,
      );
      return Promise.resolve(Response.json(served));
    },
  });
  const ok = await authorize(w, documentUrl, {
    redirect_uri: "http://127.0.0.1:8123/cb",
  });
  assertEquals(ok.response.status, 303);
  const tokens = await redeem(w, ok, {
    client_id: documentUrl,
    redirect_uri: "http://127.0.0.1:8123/cb",
  });
  assertEquals(tokens.status, 200);
  assertEquals(fetches, 1);
  served = { ...served, client_id: "https://tool.test/other.json" };
  w.clock.advance(61_000);
  assertEquals(
    (await authorize(w, documentUrl, { redirect_uri: "http://127.0.0.1/cb" }))
      .response.status,
    400,
  );
  served = { ...served, client_id: documentUrl, client_secret: "x" };
  w.clock.advance(61_000);
  assertEquals(
    (await authorize(w, documentUrl, { redirect_uri: "http://127.0.0.1/cb" }))
      .response.status,
    400,
  );
  // Off by default.
  const off = await world();
  assertEquals(
    (await authorize(off, documentUrl, { redirect_uri: "http://127.0.0.1/cb" }))
      .response.status,
    400,
  );
});

Deno.test("device grant: pending, slow down, approve, deny, expire", async () => {
  const w = await world();
  const start = async () =>
    await body(
      await w.handle(
        post(
          w.server.endpoint("device"),
          { scope: "read", resource: API },
          WEB_AUTH,
        ),
      ),
    );
  const poll = (deviceCode: string) =>
    w.handle(post(w.server.endpoint("token"), {
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      device_code: deviceCode,
    }, WEB_AUTH));
  const device = await start();
  assertEquals(device.verification_uri, `${ISSUER}/device`);
  assert(
    /^[B-Z]{4}-[B-Z]{4}$/.test(device.user_code as string),
    String(device.user_code),
  );
  assertEquals(device.interval, 5);
  assertEquals(
    new URL(device.verification_uri_complete as string).searchParams.get(
      "user_code",
    ),
    device.user_code,
  );
  await oauthError(
    await poll(device.device_code as string),
    400,
    "authorization_pending",
  );
  w.clock.advance(1_000);
  await oauthError(await poll(device.device_code as string), 400, "slow_down");
  const request = await w.server.device(
    (device.user_code as string).toLowerCase(),
  );
  assertEquals(request?.client.client_id, "web-app");
  assertEquals(request?.scope, ["read"]);
  assert(
    await w.server.decideDevice(device.user_code as string, {
      grant: { subject: "tv-user" },
    }),
    "decided",
  );
  assert(
    !(await w.server.decideDevice(device.user_code as string, {
      grant: { subject: "x" },
    })),
    "once",
  );
  assertEquals(await w.server.device(device.user_code as string), null);
  w.clock.advance(11_000);
  const tokens = await poll(device.device_code as string);
  assertEquals(tokens.status, 200);
  assertEquals(
    (await accessClaims(w, (await body(tokens)).access_token as string)).sub,
    "tv-user",
  );
  await oauthError(
    await poll(device.device_code as string),
    400,
    "invalid_grant",
  );

  const denied = await start();
  await w.server.decideDevice(denied.user_code as string, { deny: {} });
  await oauthError(
    await poll(denied.device_code as string),
    400,
    "access_denied",
  );

  const expired = await start();
  w.clock.advance(601_000);
  await oauthError(
    await poll(expired.device_code as string),
    400,
    "expired_token",
  );
  assertEquals(await w.server.device(expired.user_code as string), null);

  const unknown = await w.handle(
    post(w.server.endpoint("device"), { resource: API }, {
      authorization: `Basic ${btoa(`post-app:${SECRET}`)}`,
    }),
  );
  await oauthError(unknown, 401, "invalid_client");
});

Deno.test("token exchange: through the host's hook, with act", async () => {
  const w = await world({
    tokenExchange: async (context) => {
      const claims = await context.verifyAccessToken(context.subjectToken);
      if (claims === null) return null;
      return {
        subject: claims.sub as string,
        scope: ["read"],
        act: { sub: context.client.client_id },
      };
    },
  });
  const subject = await body(await redeem(w, await authorize(w, "public-app")));
  const exchange = (subjectToken: string, extra: Record<string, string> = {}) =>
    w.handle(post(w.server.endpoint("token"), {
      grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
      subject_token: subjectToken,
      subject_token_type: "urn:ietf:params:oauth:token-type:access_token",
      resource: OTHER_API,
      ...extra,
    }, WEB_AUTH));
  const response = await body(await exchange(subject.access_token as string));
  assertEquals(
    response.issued_token_type,
    "urn:ietf:params:oauth:token-type:access_token",
  );
  const claims = await accessClaims(w, response.access_token as string);
  assertEquals(claims.sub, "user-1");
  assertEquals(claims.aud, OTHER_API);
  assertEquals(claims.act, { sub: "web-app" });
  assertEquals(claims.client_id, "web-app");
  await oauthError(await exchange("garbage"), 400, "invalid_grant");
  await oauthError(
    await exchange(subject.access_token as string, {
      requested_token_type: "urn:ietf:params:oauth:token-type:refresh_token",
    }),
    400,
    "invalid_request",
  );
  const off = await world();
  await oauthError(
    await off.handle(post(off.server.endpoint("token"), {
      grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
      subject_token: "x",
      subject_token_type: "urn:ietf:params:oauth:token-type:access_token",
    }, WEB_AUTH)),
    400,
    "unsupported_grant_type",
  );
});

Deno.test("token exchange: the hook sees the requester's DPoP thumbprint", async () => {
  const seen: (string | undefined)[] = [];
  const w = await world({
    tokenExchange: async (context) => {
      seen.push(context.jkt);
      const claims = await context.verifyAccessToken(context.subjectToken);
      return claims === null ? null : { subject: claims.sub as string };
    },
  });
  const subject = await body(await redeem(w, await authorize(w, "public-app")));
  const key = await DpopKey.generate({ now: w.clock.now });
  const request = async (headers: Record<string, string>) =>
    await w.handle(post(w.server.endpoint("token"), {
      grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
      subject_token: subject.access_token as string,
      subject_token_type: "urn:ietf:params:oauth:token-type:access_token",
      resource: OTHER_API,
    }, { ...WEB_AUTH, ...headers }));
  const bound = await body(await request(await tokenProof(w, key)));
  assertEquals(bound.token_type, "DPoP");
  const unbound = await body(await request({}));
  assertEquals(unbound.token_type, "Bearer");
  assertEquals(seen, [key.jkt, undefined]);
});

Deno.test("resolveClient: unknown ids are resolved after the configured and stored ones", async () => {
  const asked: string[] = [];
  const w = await world({
    resolveClient: (clientId) => {
      asked.push(clientId);
      if (clientId === "https://rp.test") {
        return Promise.resolve({
          client_id: "https://rp.test",
          redirect_uris: ["https://rp.test/cb"],
        });
      }
      if (clientId === "liar") {
        return Promise.resolve({ client_id: "someone-else" });
      }
      return Promise.resolve(null);
    },
  });
  const resolved = await w.server.client("https://rp.test");
  assertEquals(resolved?.source, "resolved");
  assertEquals(resolved?.token_endpoint_auth_method, "none");
  assertEquals(await w.server.client("liar"), null);
  assertEquals(await w.server.client("nobody"), null);
  assertEquals((await w.server.client("public-app"))?.source, "static");
  assertEquals(asked, ["https://rp.test", "liar", "nobody"]);
  const authorized = await authorize(w, "https://rp.test", {
    redirect_uri: "https://rp.test/cb",
  });
  assert(authorized.code !== null, "a resolved client can authorize");
});

Deno.test("revocation and introspection", async () => {
  const w = await world();
  const tokens = await body(await redeem(w, await authorize(w, "public-app")));
  const access = tokens.access_token as string;
  const refreshToken = tokens.refresh_token as string;
  const active = await introspect(w, access);
  assertEquals(active.active, true);
  assertEquals(active.sub, "user-1");
  assertEquals(active.token_type, "Bearer");
  // A refresh token is only described to its own client.
  assertEquals((await introspect(w, refreshToken)).active, false);
  await oauthError(
    await w.handle(
      post(w.server.endpoint("introspection"), {
        token: access,
        client_id: "public-app",
      }),
    ),
    401,
    "invalid_client",
  );
  const revoke = (token: string, clientId = "public-app") =>
    w.handle(
      post(w.server.endpoint("revocation"), { token, client_id: clientId }),
    );
  // Another client's revocation is ignored, and still answers 200.
  assertEquals((await revoke(access, "bound-app")).status, 200);
  assertEquals((await introspect(w, access)).active, true);
  assertEquals((await revoke(access)).status, 200);
  assertEquals((await introspect(w, access)).active, false);
  assertEquals((await revoke(refreshToken)).status, 200);
  await oauthError(await refresh(w, refreshToken), 400, "invalid_grant");
  assertEquals((await revoke("not-a-token")).status, 200);
  await oauthError(
    await w.handle(
      post(w.server.endpoint("revocation"), { client_id: "public-app" }),
    ),
    400,
    "invalid_request",
  );
  assertEquals((await introspect(w, "garbage")).active, false);
  // Expired tokens are inactive.
  const later = await body(await redeem(w, await authorize(w, "public-app")));
  w.clock.advance(301_000);
  assertEquals(
    (await introspect(w, later.access_token as string)).active,
    false,
  );
});

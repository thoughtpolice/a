// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

import { assert, assertEquals, assertThrows } from "@celld/assert";
import { v } from "@celld/sieve";
import {
  generateKeyPair,
  generateSecret,
  JwtError,
  localJwks,
  sign,
} from "@celld/jwt";
import {
  apiKey,
  AuthError,
  basic,
  bearer,
  challengeParams,
  dpop,
  formatChallenge,
  hashApiKey,
  hashedKeys,
  jwtBearer,
  router,
  RouterError,
  session,
  timingSafeEqual,
  type TokenRequest,
} from "@celld/router";
import { assertHeader, assertMatch, assertStatus, call } from "./fixture.ts";

// bearer

function bearerApp(options: { allowQuery?: boolean } = {}) {
  const seen: TokenRequest[] = [];
  const scheme = bearer({
    verify: (request) => {
      seen.push(request);
      if (request.token === "good") return { subject: "ada", scopes: ["read"] };
      if (request.token === "bound") {
        return { subject: "ada", cnf: { jkt: "abc" } };
      }
      if (request.token === "expired") {
        return new AuthError("invalid_token", "the access token expired");
      }
      return null;
    },
    ...options,
  });
  const app = router({ auth: scheme });
  app.get("/me", (c) => c.json({ subject: c.principal.subject }));
  return { app, seen };
}

Deno.test("bearer: a good token, with everything the verifier needs", async () => {
  const { app, seen } = bearerApp();
  const answer = await call(app, "/me?x=1", {
    headers: { authorization: "Bearer good", dpop: "proof" },
  });
  assertEquals(answer.json, { subject: "ada" });
  assertEquals(seen[0].token, "good");
  assertEquals(seen[0].scheme, "Bearer");
  assertEquals(seen[0].proof, "proof");
  assertEquals(seen[0].method, "GET");
  assertEquals(seen[0].url, "https://api.example.com/me?x=1");
  assert(seen[0].request instanceof Request, "the request is passed");
});

Deno.test("bearer: the scheme name is case-insensitive and spacing is tolerated", async () => {
  const { app } = bearerApp();
  assertStatus(
    await call(app, "/me", { headers: { authorization: "bearer   good" } }),
    200,
  );
  assertStatus(
    await call(app, "/me", { headers: { authorization: "BEARER good" } }),
    200,
  );
});

Deno.test("bearer: no token is a bare challenge", async () => {
  const { app } = bearerApp();
  const answer = await call(app, "/me");
  assertStatus(answer, 401);
  assertHeader(answer, "www-authenticate", "Bearer");
});

Deno.test("bearer: another scheme in Authorization is not a bearer token", async () => {
  const { app, seen } = bearerApp();
  const answer = await call(app, "/me", {
    headers: { authorization: "Basic YTpi" },
  });
  assertStatus(answer, 401);
  assertHeader(answer, "www-authenticate", "Bearer");
  assertEquals(seen.length, 0);
});

Deno.test("bearer: an invalid token is 401 invalid_token", async () => {
  const { app } = bearerApp();
  const answer = await call(app, "/me", {
    headers: { authorization: "Bearer nope" },
  });
  assertStatus(answer, 401);
  assertHeader(
    answer,
    "www-authenticate",
    'Bearer error="invalid_token", error_description="the access token is not valid"',
  );
  assertMatch(answer.json, {
    error: "invalid_token",
    message: "the access token is not valid",
  });
  const expired = await call(app, "/me", {
    headers: { authorization: "Bearer expired" },
  });
  assertHeader(
    expired,
    "www-authenticate",
    'Bearer error="invalid_token", error_description="the access token expired"',
  );
});

Deno.test("bearer: malformed tokens are 400 invalid_request", async () => {
  const { app, seen } = bearerApp();
  for (
    const header of ["Bearer", "Bearer a b", "Bearer a,b", 'Bearer "quoted"']
  ) {
    const answer = await call(app, "/me", {
      headers: { authorization: header },
    });
    assertStatus(answer, 400);
    assertHeader(
      answer,
      "www-authenticate",
      'Bearer error="invalid_request", error_description="the bearer token is malformed"',
    );
  }
  assertEquals(seen.length, 0);
});

Deno.test("bearer: a token in the query string is refused by default", async () => {
  const { app, seen } = bearerApp();
  const answer = await call(app, "/me?access_token=good");
  assertStatus(answer, 400);
  assertHeader(
    answer,
    "www-authenticate",
    'Bearer error="invalid_request", error_description="access tokens in the query string are refused"',
  );
  assertEquals(seen.length, 0);
  const both = await call(app, "/me?access_token=good", {
    headers: { authorization: "Bearer good" },
  });
  assertStatus(both, 400);
});

Deno.test("bearer: allowQuery takes it, but never two tokens", async () => {
  const { app } = bearerApp({ allowQuery: true });
  assertStatus(await call(app, "/me?access_token=good"), 200);
  const both = await call(app, "/me?access_token=good", {
    headers: { authorization: "Bearer good" },
  });
  assertStatus(both, 400);
  assertMatch(both.json, { message: "more than one access token was sent" });
  assertStatus(await call(app, "/me?access_token=good&access_token=good"), 400);
});

Deno.test("bearer: a DPoP-bound token without a proof is refused", async () => {
  const { app } = bearerApp();
  const answer = await call(app, "/me", {
    headers: { authorization: "Bearer bound" },
  });
  assertStatus(answer, 401);
  assertHeader(
    answer,
    "www-authenticate",
    'Bearer error="invalid_token", error_description="the access token is DPoP-bound; send it with a DPoP proof"',
  );
});

Deno.test("bearer: error descriptions are sanitised to RFC 6750's characters", async () => {
  const app = router({
    auth: bearer({
      verify: () => new AuthError("invalid_token", 'bad "quote" \\ and é'),
    }),
  });
  app.get("/", (c) => c.text("x"));
  const answer = await call(app, "/", {
    headers: { authorization: "Bearer x" },
  });
  assertHeader(
    answer,
    "www-authenticate",
    'Bearer error="invalid_token", error_description="bad ?quote? ? and ?"',
  );
});

// jwtBearer

async function jwtFixture() {
  const { privateKey, publicJwk } = await generateKeyPair("ES256", {
    kid: "k1",
  });
  const other = await generateKeyPair("ES256", { kid: "k1" });
  const scheme = jwtBearer({
    keys: localJwks({ keys: [publicJwk] }),
    issuer: "https://auth.example.com",
    audience: "https://api.example.com",
    algorithms: ["ES256"],
    realm: "api",
  });
  const app = router({ auth: scheme });
  app.get("/me", { scopes: ["notes:read"] }, (c) => c.json(c.principal));
  const mint = (
    claims: Record<string, unknown>,
    key = privateKey,
    expiresIn: number | null = 300,
  ) =>
    sign(
      {
        iss: "https://auth.example.com",
        aud: "https://api.example.com",
        sub: "alice",
        ...claims,
      },
      key,
      { alg: "ES256", kid: "k1", ...(expiresIn === null ? {} : { expiresIn }) },
    );
  return { app, mint, otherKey: other.privateKey, privateKey };
}

Deno.test("jwtBearer: a good token maps its claims", async () => {
  const { app, mint } = await jwtFixture();
  const token = await mint({
    scope: "notes:read notes:write",
    client_id: "cli",
    tid: "t9",
    roles: ["admin"],
  });
  const answer = await call(app, "/me", {
    headers: { authorization: `Bearer ${token}` },
  });
  assertStatus(answer, 200);
  assertMatch(answer.json, {
    subject: "alice",
    scopes: ["notes:read", "notes:write"],
    roles: ["admin"],
    clientId: "cli",
    tenant: "t9",
    scheme: "bearer",
  });
  assertEquals(
    (answer.json!.claims as Record<string, unknown>).iss,
    "https://auth.example.com",
  );
});

Deno.test("jwtBearer: scp lists work as scopes", async () => {
  const { app, mint } = await jwtFixture();
  const token = await mint({ scp: ["notes:read"] });
  assertStatus(
    await call(app, "/me", { headers: { authorization: `Bearer ${token}` } }),
    200,
  );
});

Deno.test("jwtBearer: every refusal is invalid_token with a short reason", async () => {
  const { app, mint, otherKey, privateKey: privateKeyOf } = await jwtFixture();
  const cases: [Promise<string>, string][] = [
    [mint({ scope: "notes:read" }, otherKey), "the access token is not valid"],
    [
      mint({ scope: "notes:read", aud: "https://other.example.com" }),
      "the access token is for another audience",
    ],
    [
      mint({ scope: "notes:read", iss: "https://evil.example.com" }),
      "the access token is from another issuer",
    ],
    [
      mint({ scope: "notes:read", exp: 1000 }, privateKeyOf, null),
      "the access token expired",
    ],
    [
      mint({ scope: "notes:read" }, privateKeyOf, null),
      "the access token lacks a required claim",
    ],
  ];
  for (const [pending, description] of cases) {
    const answer = await call(app, "/me", {
      headers: { authorization: `Bearer ${await pending}` },
    });
    assertStatus(answer, 401);
    assertHeader(
      answer,
      "www-authenticate",
      `Bearer realm="api", error="invalid_token", error_description="${description}"`,
    );
  }
});

Deno.test("jwtBearer: an HS256 token is refused when only ES256 is allowed", async () => {
  const { app } = await jwtFixture();
  const secret = generateSecret("HS256");
  const token = await sign(
    {
      iss: "https://auth.example.com",
      aud: "https://api.example.com",
      sub: "x",
    },
    secret,
    { alg: "HS256", expiresIn: 60 },
  );
  const answer = await call(app, "/me", {
    headers: { authorization: `Bearer ${token}` },
  });
  assertStatus(answer, 401);
  assertHeader(
    answer,
    "www-authenticate",
    'Bearer realm="api", error="invalid_token", error_description="the access token\'s algorithm is not accepted"',
  );
});

Deno.test("jwtBearer: a missing scope is 403 insufficient_scope", async () => {
  const { app, mint } = await jwtFixture();
  const token = await mint({ scope: "profile" });
  const answer = await call(app, "/me", {
    headers: { authorization: `Bearer ${token}` },
  });
  assertStatus(answer, 403);
  assertHeader(
    answer,
    "www-authenticate",
    'Bearer realm="api", error="insufficient_scope", error_description="this needs the scopes: notes:read", scope="notes:read"',
  );
});

Deno.test("jwtBearer: an unreachable key set is a 503, not a 401", async () => {
  const app = router({
    auth: jwtBearer({
      keys: { resolve: () => Promise.reject(new JwtError("jwks", "down")) },
      issuer: "i",
      audience: "a",
      algorithms: ["ES256"],
    }),
  });
  app.get("/", (c) => c.text("x"));
  const { mint } = await jwtFixture();
  const answer = await call(app, "/", {
    headers: { authorization: `Bearer ${await mint({})}` },
  });
  assertStatus(answer, 503);
  assertMatch(answer.json, { error: "unavailable", message: "internal error" });
});

Deno.test("jwtBearer: needs algorithms", () => {
  assertThrows(
    () =>
      jwtBearer({
        keys: { keys: [] },
        issuer: "i",
        audience: "a",
        algorithms: [],
      }),
    RouterError,
    "at least one algorithm",
  );
});

// dpop

function dpopApp(nonce?: string) {
  const seen: TokenRequest[] = [];
  const scheme = dpop({
    verify: (request) => {
      seen.push(request);
      if (request.token === "bound") {
        return { subject: "ada", cnf: { jkt: "thumb" }, scopes: ["read"] };
      }
      if (request.token === "unbound") return { subject: "ada" };
      if (request.token === "stale") {
        return new AuthError(
          "use_dpop_nonce",
          "Resource server requires nonce in DPoP proof",
        );
      }
      return null;
    },
    ...(nonce === undefined ? {} : { nonce: () => nonce }),
  });
  const app = router({ auth: [bearer({ verify: () => null }), scheme] });
  app.post("/things", { scopes: ["write"] }, (c) => c.text("made"));
  app.get(
    "/things",
    (c) => c.json({ jkt: c.principal.cnf?.jkt, scheme: c.principal.scheme }),
  );
  return { app, seen };
}

const PROOF = "eyJhbGciOiJFUzI1NiJ9.eyJodG0iOiJHRVQifQ.c2ln";

Deno.test("dpop: token and proof reach the verifier; the principal is bound", async () => {
  const { app, seen } = dpopApp();
  const answer = await call(app, "/things", {
    headers: { authorization: "DPoP bound", dpop: PROOF },
  });
  assertEquals(answer.json, { jkt: "thumb", scheme: "dpop" });
  assertEquals(seen[0].scheme, "DPoP");
  assertEquals(seen[0].proof, PROOF);
  assertEquals(seen[0].url, "https://api.example.com/things");
});

Deno.test("dpop: the 401 challenges both schemes, with algs", async () => {
  const { app } = dpopApp();
  const answer = await call(app, "/things");
  assertStatus(answer, 401);
  assertHeader(
    answer,
    "www-authenticate",
    'Bearer, DPoP algs="ES256 RS256 PS256"',
  );
});

Deno.test("dpop: missing, repeated and malformed proofs are invalid_dpop_proof", async () => {
  const { app, seen } = dpopApp();
  const cases: [Record<string, string>, string][] = [
    [{ authorization: "DPoP bound" }, "the request has no DPoP proof"],
    [
      { authorization: "DPoP bound", dpop: `${PROOF}, ${PROOF}` },
      "the DPoP proof is malformed",
    ],
    [
      { authorization: "DPoP bound", dpop: "not-a-jwt" },
      "the DPoP proof is malformed",
    ],
  ];
  for (const [headers, description] of cases) {
    const answer = await call(app, "/things", { headers });
    assertStatus(answer, 401);
    assertHeader(
      answer,
      "www-authenticate",
      `DPoP algs="ES256 RS256 PS256", error="invalid_dpop_proof", error_description="${description}"`,
    );
  }
  assertEquals(seen.length, 0);
});

Deno.test("dpop: an unbound token is refused", async () => {
  const { app } = dpopApp();
  const answer = await call(app, "/things", {
    headers: { authorization: "DPoP unbound", dpop: PROOF },
  });
  assertStatus(answer, 401);
  assertHeader(
    answer,
    "www-authenticate",
    'DPoP algs="ES256 RS256 PS256", error="invalid_token", error_description="the access token is not DPoP-bound"',
  );
});

Deno.test("dpop: use_dpop_nonce carries DPoP-Nonce", async () => {
  const { app } = dpopApp("n-123");
  const answer = await call(app, "/things", {
    headers: { authorization: "DPoP stale", dpop: PROOF },
  });
  assertStatus(answer, 401);
  assertHeader(
    answer,
    "www-authenticate",
    'DPoP algs="ES256 RS256 PS256", error="use_dpop_nonce", error_description="Resource server requires nonce in DPoP proof"',
  );
  assertHeader(answer, "dpop-nonce", "n-123");
  const ok = await call(app, "/things", {
    headers: { authorization: "DPoP bound", dpop: PROOF },
  });
  assertHeader(ok, "dpop-nonce", "n-123");
});

Deno.test("dpop: insufficient_scope is a DPoP challenge", async () => {
  const { app } = dpopApp();
  const answer = await call(app, "/things", {
    method: "POST",
    headers: { authorization: "DPoP bound", dpop: PROOF },
  });
  assertStatus(answer, 403);
  assertHeader(
    answer,
    "www-authenticate",
    'DPoP algs="ES256 RS256 PS256", error="insufficient_scope", error_description="this needs the scopes: write", scope="write"',
  );
});

Deno.test("verifier headers reach success and every later answer", async () => {
  const scheme = dpop({
    verify: () => ({
      subject: "ada",
      cnf: { jkt: "thumb" },
      scopes: ["read"],
      headers: { "dpop-nonce": "fresh-1" },
    }),
  });
  const app = router({ auth: scheme });
  app.get("/things", (c) => c.text("ok"));
  app.post("/things", { scopes: ["write"] }, (c) => c.text("made"));
  app.put(
    "/things",
    { body: v.object({ name: v.string() }) },
    (c) => c.text(c.body.name),
  );
  app.delete("/things", (c) => c.fail(409, "busy"));
  const headers = { authorization: "DPoP bound", dpop: PROOF };
  const ok = await call(app, "/things", { headers });
  assertStatus(ok, 200);
  assertHeader(ok, "dpop-nonce", "fresh-1");
  const forbidden = await call(app, "/things", { method: "POST", headers });
  assertStatus(forbidden, 403);
  assertHeader(forbidden, "dpop-nonce", "fresh-1");
  const invalid = await call(app, "/things", {
    method: "PUT",
    headers,
    json: { name: 1 },
  });
  assertStatus(invalid, 400);
  assertHeader(invalid, "dpop-nonce", "fresh-1");
  const failed = await call(app, "/things", { method: "DELETE", headers });
  assertStatus(failed, 409);
  assertHeader(failed, "dpop-nonce", "fresh-1");
});

Deno.test("verifier headers are not part of the principal", async () => {
  const app = router({
    auth: bearer({
      verify: () => ({
        subject: "ada",
        headers: [["x-one", "1"], ["set-cookie", "a=1"], ["set-cookie", "b=2"]],
      }),
    }),
  });
  app.get("/me", (c) => c.json(c.principal));
  const response = await app.fetch(
    new Request("https://api.example.com/me", {
      headers: { authorization: "Bearer good" },
    }),
  );
  const principal = await response.json();
  assertEquals(principal.headers, undefined);
  assertEquals(response.headers.get("x-one"), "1");
  assertEquals(response.headers.getSetCookie(), ["a=1", "b=2"]);
});

Deno.test("resource_metadata and realm go on every token challenge", async () => {
  const metadata =
    "https://api.example.com/.well-known/oauth-protected-resource";
  const verify = (request: TokenRequest) =>
    request.token === "good"
      ? { subject: "ada", scopes: ["read"] }
      : request.token === "bound"
      ? { subject: "ada", scopes: ["read"], cnf: { jkt: "thumb" } }
      : null;
  const app = router({
    auth: [
      dpop({ verify, realm: "files", resourceMetadata: metadata }),
      bearer({ verify, realm: "files", resourceMetadata: metadata }),
    ],
  });
  app.get("/things", { scopes: ["write"] }, (c) => c.text("x"));
  const bare = await call(app, "/things");
  assertStatus(bare, 401);
  assertHeader(
    bare,
    "www-authenticate",
    `DPoP realm="files", algs="ES256 RS256 PS256", resource_metadata="${metadata}", Bearer realm="files", resource_metadata="${metadata}"`,
  );
  const refused = await call(app, "/things", {
    headers: { authorization: "Bearer nope" },
  });
  assertHeader(
    refused,
    "www-authenticate",
    `Bearer realm="files", error="invalid_token", error_description="the access token is not valid", resource_metadata="${metadata}"`,
  );
  const scope = await call(app, "/things", {
    headers: { authorization: "Bearer good" },
  });
  assertStatus(scope, 403);
  assertHeader(
    scope,
    "www-authenticate",
    `Bearer realm="files", error="insufficient_scope", error_description="this needs the scopes: write", scope="write", resource_metadata="${metadata}"`,
  );
  const dpopScope = await call(app, "/things", {
    headers: { authorization: "DPoP bound", dpop: PROOF },
  });
  assertStatus(dpopScope, 403);
  assertHeader(
    dpopScope,
    "www-authenticate",
    `DPoP realm="files", algs="ES256 RS256 PS256", error="insufficient_scope", error_description="this needs the scopes: write", scope="write", resource_metadata="${metadata}"`,
  );
});

Deno.test("jwtBearer: resourceMetadata reaches its challenges", async () => {
  const app = router({
    auth: jwtBearer({
      keys: { keys: [] },
      issuer: "i",
      audience: "a",
      algorithms: ["ES256"],
      resourceMetadata: "https://api.example.com/.well-known/x",
    }),
  });
  app.get("/", (c) => c.text("x"));
  assertHeader(
    await call(app, "/"),
    "www-authenticate",
    'Bearer resource_metadata="https://api.example.com/.well-known/x"',
  );
});

Deno.test("jwtBearer: an algorithm the runtime cannot verify is a reported 500", async () => {
  const reported: unknown[] = [];
  const app = router({
    auth: jwtBearer({
      keys: {
        resolve: () =>
          Promise.reject(
            new JwtError("runtime_unsupported", "no Ed25519 here"),
          ),
      },
      issuer: "i",
      audience: "a",
      algorithms: ["ES256"],
    }),
    onError: (error) => void reported.push(error),
  });
  app.get("/", (c) => c.text("x"));
  const { mint } = await jwtFixture();
  const answer = await call(app, "/", {
    headers: { authorization: `Bearer ${await mint({})}` },
  });
  assertStatus(answer, 500);
  assertHeader(answer, "www-authenticate", null);
  assertEquals((reported[0] as JwtError).code, "runtime_unsupported");
});

Deno.test("challenge values are quoted, and unsafe characters dropped", () => {
  assertEquals(
    formatChallenge({
      scheme: "Bearer",
      params: [
        ["realm", 'a "quoted" \\ realm'],
        ["resource_metadata", "https://x.example/\r\nSet-Cookie: a=1"],
      ],
    }),
    'Bearer realm="a \\"quoted\\" \\\\ realm", resource_metadata="https://x.example/??Set-Cookie: a=1"',
  );
  assertEquals(
    challengeParams(
      { realm: "r", resourceMetadata: "m" },
      new AuthError("invalid_token", "bad", { scope: ["a", "b"] }),
      [["algs", "ES256"]],
    ),
    [
      ["realm", "r"],
      ["algs", "ES256"],
      ["error", "invalid_token"],
      ["error_description", "bad"],
      ["scope", "a b"],
      ["resource_metadata", "m"],
    ],
  );
});

// apiKey

Deno.test("apiKey: hashed lookups, 401 for unknown keys, 400 for malformed ones", async () => {
  const hash = await hashApiKey("sk_live_0123456789abcdef");
  assertEquals(hash.length, 64);
  const app = router({
    auth: apiKey({
      lookup: hashedKeys({ [hash]: { subject: "svc", scopes: ["hooks"] } }),
    }),
  });
  app.post("/hook", { scopes: ["hooks"] }, (c) => c.text(c.principal.subject));
  assertEquals(
    (await call(app, "/hook", {
      method: "POST",
      headers: { "x-api-key": "sk_live_0123456789abcdef" },
    })).text,
    "svc",
  );
  const none = await call(app, "/hook", { method: "POST" });
  assertStatus(none, 401);
  assertHeader(
    none,
    "www-authenticate",
    'ApiKey realm="api", header="x-api-key"',
  );
  const wrong = await call(app, "/hook", {
    method: "POST",
    headers: { "x-api-key": "sk_live_x" },
  });
  assertStatus(wrong, 401);
  assertHeader(
    wrong,
    "www-authenticate",
    'ApiKey realm="api", header="x-api-key", error="invalid_credentials", error_description="the API key is not valid"',
  );
  const malformed = await call(app, "/hook", {
    method: "POST",
    headers: { "x-api-key": "a, b" },
  });
  assertStatus(malformed, 400);
});

Deno.test("apiKey: a query parameter when asked for, never both places", async () => {
  const app = router({
    auth: apiKey({
      query: "key",
      lookup: (key) => key === "k" ? { subject: "q" } : null,
    }),
  });
  app.get("/", (c) => c.text(c.principal.subject));
  assertEquals((await call(app, "/?key=k")).text, "q");
  assertStatus(await call(app, "/?key=k&key=k"), 400);
  assertHeader(
    await call(app, "/"),
    "www-authenticate",
    'ApiKey realm="api", query="key"',
  );
  assertThrows(
    () => apiKey({ header: "a", query: "b", lookup: () => null }),
    RouterError,
    "not both",
  );
});

// basic

function basicApp(allowInsecure = false) {
  const app = router({
    auth: basic({
      verify: (user, password) =>
        user === "ada" && timingSafeEqual(password, "pä:ss")
          ? { subject: user }
          : null,
      allowInsecure,
    }),
  });
  app.get("/", (c) => c.text(c.principal.subject));
  return app;
}

function basicHeader(user: string, password: string) {
  const bytes = new TextEncoder().encode(`${user}:${password}`);
  return { authorization: `Basic ${btoa(String.fromCharCode(...bytes))}` };
}

Deno.test("basic: UTF-8 credentials over https; a colon in the password is fine", async () => {
  const app = basicApp();
  assertEquals(
    (await call(app, "/", { headers: basicHeader("ada", "pä:ss") })).text,
    "ada",
  );
  const wrong = await call(app, "/", { headers: basicHeader("ada", "nope") });
  assertStatus(wrong, 401);
  assertHeader(wrong, "www-authenticate", 'Basic realm="api", charset="UTF-8"');
  const none = await call(app, "/");
  assertHeader(none, "www-authenticate", 'Basic realm="api", charset="UTF-8"');
});

Deno.test("basic: malformed credentials are 400", async () => {
  const app = basicApp();
  for (const credentials of ["!!!", "YWRh", "/w=="]) {
    const answer = await call(app, "/", {
      headers: { authorization: `Basic ${credentials}` },
    });
    assertStatus(answer, 400);
    assertMatch(answer.json, { error: "invalid_request" });
  }
});

Deno.test("basic: refused over plain http, with no challenge to prompt a password", async () => {
  const app = basicApp();
  const answer = await call(app, "/", {
    origin: "http://api.example.com",
    headers: basicHeader("ada", "pä:ss"),
  });
  assertStatus(answer, 403);
  assertMatch(answer.json, { error: "insecure_transport" });
  assertHeader(answer, "www-authenticate", null);
  const none = await call(app, "/", { origin: "http://api.example.com" });
  assertStatus(none, 401);
  assertHeader(none, "www-authenticate", null);
  const allowed = basicApp(true);
  assertEquals(
    (await call(allowed, "/", {
      origin: "http://api.example.com",
      headers: basicHeader("ada", "pä:ss"),
    })).text,
    "ada",
  );
});

// session

const SECRET = "0123456789abcdef0123456789abcdef";

function sessionApp(
  now: { t: number },
  keys = [{ id: "k1", secret: SECRET }],
  encrypt = true,
) {
  const sessions = session({ keys, now: () => now.t, maxAge: "PT1H", encrypt });
  const app = router({ auth: sessions });
  app.post("/login", { public: true, csrf: false }, async (c) => {
    await sessions.issue(c, {
      subject: "ada",
      scopes: ["notes"],
      claims: { name: "Ada" },
    });
    return c.text("in");
  });
  app.post("/logout", (c) => {
    sessions.clear(c);
    return c.text("out");
  });
  app.get(
    "/me",
    (c) => c.json({ subject: c.principal.subject, claims: c.principal.claims }),
  );
  return app;
}

function cookieOf(setCookie: string | null): string {
  assert(setCookie !== null, "a cookie was set");
  return setCookie!.split(";")[0];
}

Deno.test("session: issue, use, expire; the cookie has the safe attributes", async () => {
  const now = { t: 1_000_000 };
  const app = sessionApp(now);
  const login = await call(app, "/login", { method: "POST" });
  const setCookie = login.headers.get("set-cookie")!;
  assert(setCookie.startsWith("__Host-session=e1.k1."), setCookie);
  assert(
    setCookie.endsWith(
      "; Max-Age=3600; Path=/; Secure; HttpOnly; SameSite=Lax",
    ),
    setCookie,
  );
  const cookie = cookieOf(setCookie);
  assertEquals((await call(app, "/me", { headers: { cookie } })).json, {
    subject: "ada",
    claims: { name: "Ada" },
  });
  now.t += 3_600_000;
  const expired = await call(app, "/me", { headers: { cookie } });
  assertStatus(expired, 401);
  assertMatch(expired.json, {
    error: "invalid_credentials",
    message: "the session expired",
  });
  assert(
    expired.headers.get("set-cookie")!.startsWith(
      "__Host-session=; Max-Age=0; Expires=Thu, 01 Jan 1970",
    ),
    "the stale cookie is cleared",
  );
});

Deno.test("session: tampered cookies are refused and cleared", async () => {
  const now = { t: 1_000_000 };
  const app = sessionApp(now);
  const cookie = cookieOf(
    (await call(app, "/login", { method: "POST" })).headers.get("set-cookie"),
  );
  const target = cookie.at(-2) === "A" ? "B" : "A";
  const flipped = cookie.slice(0, -2) + target + cookie.slice(-1);
  assert(flipped !== cookie, "the cookie changed");
  const answer = await call(app, "/me", { headers: { cookie: flipped } });
  assertStatus(answer, 401);
  assertMatch(answer.json, { message: "the session is not valid" });
  assertHeader(answer, "www-authenticate", null);
  assertStatus(await call(app, "/me"), 401);
});

Deno.test("session: rotated keys still open old sessions and re-seal them", async () => {
  const now = { t: 1_000_000 };
  const before = sessionApp(now, [{ id: "old", secret: SECRET }]);
  const cookie = cookieOf(
    (await call(before, "/login", { method: "POST" })).headers.get(
      "set-cookie",
    ),
  );
  const after = sessionApp(now, [
    { id: "new", secret: "fedcba9876543210fedcba9876543210" },
    { id: "old", secret: SECRET },
  ]);
  const answer = await call(after, "/me", { headers: { cookie } });
  assertStatus(answer, 200);
  assert(
    answer.headers.get("set-cookie")!.startsWith("__Host-session=e1.new."),
    "re-sealed",
  );
  const dropped = sessionApp(now, [{
    id: "new",
    secret: "fedcba9876543210fedcba9876543210",
  }]);
  assertStatus(await call(dropped, "/me", { headers: { cookie } }), 401);
});

Deno.test("session: signed (not encrypted) sessions verify too", async () => {
  const now = { t: 1_000_000 };
  const app = sessionApp(now, undefined, false);
  const cookie = cookieOf(
    (await call(app, "/login", { method: "POST" })).headers.get("set-cookie"),
  );
  assert(cookie.startsWith("__Host-session=s1.k1."), cookie);
  assertStatus(await call(app, "/me", { headers: { cookie } }), 200);
});

Deno.test("session: logout clears the cookie", async () => {
  const now = { t: 1_000_000 };
  const app = sessionApp(now);
  const cookie = cookieOf(
    (await call(app, "/login", { method: "POST" })).headers.get("set-cookie"),
  );
  const out = await call(app, "/logout", {
    method: "POST",
    headers: { cookie },
  });
  assertEquals(out.text, "out");
  assert(out.headers.get("set-cookie")!.includes("Max-Age=0"), "expired");
});

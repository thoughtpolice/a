// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

import { assert, assertEquals } from "@celld/assert";
import { sign } from "@celld/jwt";
import { parseWwwAuthenticate, resourceChallenge } from "@celld/oauth";
import { DpopKey, DpopNonceIssuer, memoryReplayStore } from "@celld/oauth/dpop";
import {
  introspectionVerifier,
  jwtAccessTokenVerifier,
  ResourceServer,
  type ResourceServerOptions,
} from "@celld/oauth/resource";
import {
  generateSigningKey,
  issueAccessToken,
  publicJwks,
  type SigningKey,
} from "@celld/oauth/server";
import { manualClock } from "@celld/oauth/testing";
import { API, ISSUER, rejects, withUnsupportedVerify } from "./fixture.ts";

const clock = manualClock(Date.UTC(2026, 8, 25, 12));
const key = await generateSigningKey("ES256", "k1");

async function token(
  options: {
    jkt?: string;
    scope?: string[];
    audience?: string[];
    key?: SigningKey;
  } = {},
): Promise<string> {
  return (await issueAccessToken(
    options.key ?? key,
    ISSUER,
    {
      subject: "alice",
      clientId: "app",
      scope: options.scope ?? ["read"],
      audience: options.audience ?? [API],
      ...(options.jkt === undefined ? {} : { jkt: options.jkt }),
      claims: { tenant: "t1" },
    },
    300,
    clock.now,
  )).token;
}

function server(options: Partial<ResourceServerOptions> = {}): ResourceServer {
  return new ResourceServer({
    resource: API,
    authorizationServers: [ISSUER],
    verifier: jwtAccessTokenVerifier({
      issuer: ISSUER,
      audience: API,
      keys: publicJwks([key]),
      now: clock.now,
    }),
    dpop: { replay: memoryReplayStore({ now: clock.now }) },
    now: clock.now,
    ...options,
  });
}

function get(
  headers: Record<string, string> = {},
  url = `${API}/files`,
): Request {
  return new Request(url, { headers });
}

async function dpopHeaders(
  dpop: DpopKey,
  accessToken: string,
  options: { url?: string; method?: string; nonce?: string } = {},
): Promise<Record<string, string>> {
  return {
    authorization: `DPoP ${accessToken}`,
    dpop: await dpop.proof({
      method: options.method ?? "GET",
      url: options.url ?? `${API}/files`,
      accessToken,
      nonce: options.nonce,
      now: clock.now,
    }),
  };
}

Deno.test("metadata: RFC 9728 with DPoP members, served at its well-known path", async () => {
  const api = server({
    scopesSupported: ["read"],
    metadata: { resource_name: "Files" },
  });
  assertEquals(
    api.resourceMetadataUrl,
    `${API}/.well-known/oauth-protected-resource`,
  );
  const response = api.handleMetadata(new Request(api.resourceMetadataUrl))!;
  assertEquals(response.status, 200);
  const document = await response.json();
  assertEquals(document.resource, API);
  assertEquals(document.authorization_servers, [ISSUER]);
  assertEquals(document.bearer_methods_supported, ["header"]);
  assertEquals(document.scopes_supported, ["read"]);
  assertEquals(document.resource_name, "Files");
  assert(
    document.dpop_signing_alg_values_supported.includes("ES256"),
    "DPoP algorithms",
  );
  assertEquals(document.dpop_bound_access_tokens_required, undefined);
  assertEquals(api.handleMetadata(get()), null);
  const strict = server({ dpop: { required: true } });
  assertEquals(strict.metadata.dpop_bound_access_tokens_required, true);
  const bearerOnly = server({ dpop: false });
  assertEquals(
    bearerOnly.metadata.dpop_signing_alg_values_supported,
    undefined,
  );
  let threw = false;
  try {
    server({ scopesSupported: ["offline_access"] });
  } catch {
    threw = true;
  }
  assert(threw, "offline_access is not a resource scope");
  threw = false;
  try {
    server({ resource: "http://api.example.com" });
  } catch {
    threw = true;
  }
  assert(threw, "a resource must be https");
});

Deno.test("no credentials: a 401 naming both schemes and the metadata, without an error", async () => {
  const result = await server({ requiredScopes: ["read"], realm: "files" })
    .verifyRequest(get());
  assert(!result.ok, "refused");
  assertEquals(result.challenge.status, 401);
  assertEquals(result.challenge.error, undefined);
  const header = result.challenge.headers["www-authenticate"];
  const challenges = parseWwwAuthenticate(header);
  assertEquals(challenges.map((c) => c.scheme), ["Bearer", "DPoP"]);
  assertEquals(challenges[0].params, {
    realm: "files",
    scope: "read",
    resource_metadata: `${API}/.well-known/oauth-protected-resource`,
  });
  assertEquals(challenges[1].params.algs.split(" ").includes("ES256"), true);
  const response = result.challenge.toResponse();
  assertEquals(response.status, 401);
  assertEquals(response.headers.get("www-authenticate"), header);
});

Deno.test("Bearer: accepted, with the token's facts as the principal", async () => {
  const result = await server().verifyRequest(
    get({ authorization: `Bearer ${await token()}` }),
    {
      scopes: ["read"],
    },
  );
  assert(result.ok, JSON.stringify(result));
  assertEquals(result.principal.subject, "alice");
  assertEquals(result.principal.clientId, "app");
  assertEquals(result.principal.scopes, ["read"]);
  assertEquals(result.principal.tokenType, "Bearer");
  assertEquals(result.principal.issuer, ISSUER);
  assertEquals(result.principal.claims.tenant, "t1");
  assertEquals(result.principal.cnf, undefined);
  assert(
    !("token" in result.principal),
    "the principal never carries the token",
  );
});

Deno.test("Bearer: bad tokens are 401 invalid_token on the Bearer challenge", async () => {
  const api = server();
  const other = await generateSigningKey("ES256", "k1");
  const cases = [
    await token({ audience: ["https://other.test"] }),
    await token({ key: other }),
    "not-a-jwt",
    await sign(
      {
        iss: ISSUER,
        aud: API,
        sub: "a",
        client_id: "c",
        jti: "j",
        iat: 1,
        exp: 9e9,
      },
      other.privateKey,
      {
        alg: "ES256",
        kid: "k1",
      },
    ),
  ];
  for (const bad of cases) {
    const result = await api.verifyRequest(
      get({ authorization: `Bearer ${bad}` }),
    );
    assert(!result.ok, bad);
    assertEquals(result.challenge.status, 401);
    assertEquals(result.challenge.error, "invalid_token");
    const bearer = resourceChallenge(
      result.challenge.headers["www-authenticate"],
      "Bearer",
    )!;
    assertEquals(bearer.error, "invalid_token");
    assertEquals(
      resourceChallenge(result.challenge.headers["www-authenticate"], "DPoP")!
        .error,
      null,
    );
  }
  const expired = await token();
  clock.advance(331_000);
  const late = await api.verifyRequest(
    get({ authorization: `Bearer ${expired}` }),
  );
  clock.advance(-331_000);
  assert(!late.ok && late.challenge.error === "invalid_token", "expired");
});

Deno.test("malformed Authorization headers are 400 invalid_request", async () => {
  for (
    const header of ["Bearer", "Bearer a b", "Basic dXNlcjpwYXNz", "Bearer a,b"]
  ) {
    const result = await server().verifyRequest(get({ authorization: header }));
    assert(!result.ok, header);
    assertEquals(result.challenge.status, 400, header);
    const response = result.challenge.toResponse();
    assertEquals((await response.json()).error, "invalid_request");
  }
});

Deno.test("scopes: 403 insufficient_scope naming what the request needs", async () => {
  const result = await server({ requiredScopes: ["read"] }).verifyRequest(
    get({ authorization: `Bearer ${await token()}` }),
    { scopes: ["write"] },
  );
  assert(!result.ok, "refused");
  assertEquals(result.challenge.status, 403);
  const bearer = resourceChallenge(
    result.challenge.headers["www-authenticate"],
    "Bearer",
  )!;
  assertEquals(bearer.error, "insufficient_scope");
  assertEquals(bearer.scopes, ["read", "write"]);
});

Deno.test("DPoP: a bound token with a matching proof", async () => {
  const dpop = await DpopKey.generate({ now: clock.now });
  const access = await token({ jkt: dpop.jkt });
  const api = server();
  const result = await api.verifyRequest(get(await dpopHeaders(dpop, access)));
  assert(result.ok, JSON.stringify(result));
  assertEquals(result.principal.tokenType, "DPoP");
  assertEquals(result.principal.cnf, { jkt: dpop.jkt });
  // The query string is not part of htu.
  const query = await api.verifyRequest(
    get(
      await dpopHeaders(dpop, access, { url: `${API}/files` }),
      `${API}/files?page=2`,
    ),
  );
  assert(query.ok, "a query is ignored");
});

Deno.test("DPoP: downgrades, missing proofs, wrong keys and replays are refused", async () => {
  const dpop = await DpopKey.generate({ now: clock.now });
  const thief = await DpopKey.generate({ now: clock.now });
  const bound = await token({ jkt: dpop.jkt });
  const api = server();
  const expect = async (
    headers: Record<string, string>,
    status: number,
    error: string,
    scheme: "Bearer" | "DPoP",
    url?: string,
  ) => {
    const result = await api.verifyRequest(get(headers, url));
    assert(!result.ok, `${error} should refuse`);
    assertEquals(result.challenge.status, status);
    assertEquals(result.challenge.error, error);
    const challenge = resourceChallenge(
      result.challenge.headers["www-authenticate"],
      scheme,
    )!;
    assertEquals(challenge.error, error);
  };
  // A bound token presented as a bearer token.
  await expect(
    { authorization: `Bearer ${bound}` },
    401,
    "invalid_token",
    "Bearer",
  );
  await expect(
    {
      authorization: `Bearer ${bound}`,
      dpop: (await dpopHeaders(dpop, bound)).dpop,
    },
    401,
    "invalid_token",
    "Bearer",
  );
  // An unbound token presented under DPoP.
  const unbound = await token();
  await expect(await dpopHeaders(dpop, unbound), 401, "invalid_token", "DPoP");
  // No proof.
  await expect(
    { authorization: `DPoP ${bound}` },
    401,
    "invalid_dpop_proof",
    "DPoP",
  );
  // Someone else's key.
  await expect(
    await dpopHeaders(thief, bound),
    401,
    "invalid_dpop_proof",
    "DPoP",
  );
  // A proof for another token (ath), method, or URL.
  const otherToken = await token({ jkt: dpop.jkt, scope: ["write"] });
  const wrongAth = await dpopHeaders(dpop, otherToken);
  await expect(
    { ...wrongAth, authorization: `DPoP ${bound}` },
    401,
    "invalid_dpop_proof",
    "DPoP",
  );
  await expect(
    await dpopHeaders(dpop, bound, { method: "POST" }),
    401,
    "invalid_dpop_proof",
    "DPoP",
  );
  await expect(
    await dpopHeaders(dpop, bound, { url: `${API}/other` }),
    401,
    "invalid_dpop_proof",
    "DPoP",
  );
  // Two proofs.
  const twice = await dpopHeaders(dpop, bound);
  await expect(
    { ...twice, dpop: `${twice.dpop}, ${twice.dpop}` },
    401,
    "invalid_dpop_proof",
    "DPoP",
  );
  // A replayed proof.
  const once = await dpopHeaders(dpop, bound);
  assert((await api.verifyRequest(get(once))).ok, "first use");
  await expect(once, 401, "invalid_dpop_proof", "DPoP");
  // A resource that takes only bearer tokens refuses DPoP.
  const bearerOnly = await server({ dpop: false }).verifyRequest(
    get(await dpopHeaders(dpop, bound)),
  );
  assert(
    !bearerOnly.ok && bearerOnly.challenge.error === "invalid_token",
    "DPoP off",
  );
  assertEquals(
    parseWwwAuthenticate(bearerOnly.challenge.headers["www-authenticate"]).map((
      c,
    ) => c.scheme),
    ["Bearer"],
  );
});

Deno.test("DPoP required: bearer tokens get a DPoP challenge", async () => {
  const api = server({ dpop: { required: true, replay: memoryReplayStore() } });
  const result = await api.verifyRequest(
    get({ authorization: `Bearer ${await token()}` }),
  );
  assert(!result.ok, "refused");
  const header = result.challenge.headers["www-authenticate"];
  assertEquals(parseWwwAuthenticate(header).map((c) => c.scheme), ["DPoP"]);
  assertEquals(resourceChallenge(header, "DPoP")!.error, "invalid_token");
});

Deno.test("DPoP nonces: use_dpop_nonce with a fresh nonce, then success", async () => {
  const nonce = await DpopNonceIssuer.create({ now: clock.now });
  const api = server({ dpop: { nonce, replay: memoryReplayStore() } });
  const dpop = await DpopKey.generate({ now: clock.now });
  const access = await token({ jkt: dpop.jkt });
  const first = await api.verifyRequest(get(await dpopHeaders(dpop, access)));
  assert(!first.ok, "refused");
  assertEquals(first.challenge.status, 401);
  assertEquals(first.challenge.error, "use_dpop_nonce");
  const fresh = first.challenge.headers["dpop-nonce"];
  assert(fresh !== undefined, "a DPoP-Nonce header");
  assertEquals(first.challenge.toResponse().headers.get("dpop-nonce"), fresh);
  const second = await api.verifyRequest(
    get(await dpopHeaders(dpop, access, { nonce: fresh })),
  );
  assert(second.ok, JSON.stringify(second));
  assertEquals(second.headers["dpop-nonce"], fresh);
});

Deno.test("jwtAccessTokenVerifier: a runtime that cannot verify is not a bad token", async () => {
  const verifier = jwtAccessTokenVerifier({
    issuer: ISSUER,
    audience: API,
    keys: publicJwks([key]),
    now: clock.now,
  });
  const error = await rejects(
    () => withUnsupportedVerify(async () => verifier.verify(await token())),
    { name: "JwtError", code: "runtime_unsupported" },
  );
  assertEquals((error.cause as Error).name, "NotSupportedError");
});

Deno.test("ResourceServer: a runtime that cannot verify throws instead of a 401", async () => {
  const api = server();
  const access = await token();
  await rejects(
    () =>
      withUnsupportedVerify(() =>
        api.verifyRequest(get({ authorization: `Bearer ${access}` }))
      ),
    { name: "JwtError", code: "runtime_unsupported" },
  );
});

Deno.test("jwtAccessTokenVerifier: RFC 9068 by default, plain JWTs when asked", async () => {
  const now = Math.floor(clock.now() / 1000);
  const plain = await sign(
    { iss: ISSUER, aud: API, sub: "a", exp: now + 60, scp: ["read", "write"] },
    key.privateKey,
    { alg: "ES256", kid: "k1" },
  );
  const strict = jwtAccessTokenVerifier({
    issuer: ISSUER,
    audience: API,
    keys: publicJwks([key]),
    now: clock.now,
  });
  let refused = false;
  try {
    await strict.verify(plain);
  } catch {
    refused = true;
  }
  assert(refused, "typ JWT is not at+jwt");
  const loose = jwtAccessTokenVerifier({
    issuer: ISSUER,
    audience: API,
    keys: publicJwks([key]),
    strict: false,
    now: clock.now,
  });
  const verified = await loose.verify(plain);
  assertEquals(verified.scopes, ["read", "write"]);
  const failing = jwtAccessTokenVerifier({
    issuer: ISSUER,
    audience: API,
    keys: "https://as.test/jwks",
    fetch: () => Promise.reject(new TypeError("down")),
    now: clock.now,
  });
  let status = 0;
  try {
    await failing.verify(await token());
  } catch (error) {
    status = (error as { status: number }).status;
  }
  assertEquals(status, 503);
  const result = await server({ verifier: failing }).verifyRequest(
    get({ authorization: `Bearer ${await token()}` }),
  );
  assert(
    !result.ok && result.challenge.status === 503,
    "an unreachable JWKS is a 503",
  );
});

Deno.test("introspectionVerifier: audience, issuer, caching", async () => {
  let calls = 0;
  let answer: Record<string, unknown> = {
    active: true,
    iss: ISSUER,
    aud: API,
    sub: "bob",
    client_id: "app",
    scope: "read",
    exp: Math.floor(clock.now() / 1000) + 120,
    cnf: { jkt: "x".repeat(43) },
  };
  let seen: Request | null = null;
  const verifier = introspectionVerifier({
    endpoint: `${ISSUER}/introspect`,
    issuer: ISSUER,
    client: {
      method: "client_secret_basic",
      clientId: "api",
      clientSecret: "s",
    },
    audience: API,
    cacheMs: 30_000,
    fetch: (input, init) => {
      calls++;
      seen = new Request(input, init);
      return Promise.resolve(Response.json(answer));
    },
    now: clock.now,
  });
  const verified = await verifier.verify("opaque-1");
  assertEquals(verified.subject, "bob");
  assertEquals(verified.cnf, { jkt: "x".repeat(43) });
  const request = seen as unknown as Request;
  assert(
    request.headers.get("authorization")!.startsWith("Basic "),
    "authenticated",
  );
  assertEquals(
    new URLSearchParams(await request.text()).get("token"),
    "opaque-1",
  );
  await verifier.verify("opaque-1");
  assertEquals(calls, 1);
  clock.advance(31_000);
  await verifier.verify("opaque-1");
  assertEquals(calls, 2);
  const refuse = async (value: Record<string, unknown>) => {
    answer = value;
    try {
      await verifier.verify(`t-${calls}`);
    } catch (error) {
      return (error as { code: string }).code;
    }
    return "accepted";
  };
  assertEquals(await refuse({ ...answer, active: false }), "invalid_token");
  assertEquals(
    await refuse({ ...answer, active: true, aud: "https://other.test" }),
    "invalid_token",
  );
  const noAudience: Record<string, unknown> = { ...answer, active: true };
  delete noAudience.aud;
  assertEquals(await refuse(noAudience), "invalid_token");
  assertEquals(
    await refuse({ ...noAudience, aud: API, iss: "https://evil.test" }),
    "invalid_token",
  );
  assertEquals(
    await refuse({ ...noAudience, aud: API, exp: 1 }),
    "invalid_token",
  );
  assertEquals(await refuse({ nonsense: true }), "temporarily_unavailable");
  // A bound token from introspection must be presented under DPoP.
  answer = {
    ...noAudience,
    aud: API,
    iss: ISSUER,
    exp: Math.floor(clock.now() / 1000) + 60,
  };
  const api = server({ verifier });
  const result = await api.verifyRequest(
    get({ authorization: "Bearer opaque-2" }),
  );
  assert(
    !result.ok && result.challenge.error === "invalid_token",
    "bound via introspection",
  );
});

// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

import { assert, assertEquals } from "@celld/assert";
import {
  attemptOAuth,
  authorizationServerMetadataUrls,
  basicAuthorization,
  canonicalResource,
  checkSecureUrl,
  formatChallenge,
  isCodeVerifier,
  isIssuer,
  isLoopbackHost,
  OAuthError,
  oauthErrorFromData,
  parseBasicAuthorization,
  parseScope,
  parseWwwAuthenticate,
  pkceChallenge,
  pkcePair,
  protectedResourceMetadataUrl,
  protectedResourceMetadataUrls,
  ProtocolError,
  resourceChallenge,
  resourceCovers,
  safeDescription,
  secureUrlProblem,
  timingSafeEqual,
  verifyPkce,
} from "@celld/oauth";

Deno.test("PKCE: the RFC 7636 appendix B vector", async () => {
  const verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
  assertEquals(
    await pkceChallenge(verifier),
    "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
  );
  assert(
    await verifyPkce(verifier, "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM"),
    "the vector verifies",
  );
  assert(
    !(await verifyPkce(
      verifier,
      "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cN",
    )),
    "a different challenge does not",
  );
});

Deno.test("PKCE: verifiers are 43 to 128 unreserved characters", async () => {
  assert(isCodeVerifier("a".repeat(43)), "43");
  assert(isCodeVerifier("a".repeat(128)), "128");
  assert(!isCodeVerifier("a".repeat(42)), "42");
  assert(!isCodeVerifier("a".repeat(129)), "129");
  assert(!isCodeVerifier(`${"a".repeat(42)}+`), "a reserved character");
  const pair = await pkcePair();
  assertEquals(pair.method, "S256");
  assertEquals(pair.verifier.length, 43);
  assert(
    await verifyPkce(pair.verifier, pair.challenge),
    "a new pair verifies",
  );
  // A short verifier never verifies, even against its own hash.
  assert(!(await verifyPkce("short", await pkceChallenge("short"))), "short");
});

Deno.test("challenges: parsing several schemes and parameters", () => {
  const header =
    'Basic realm="x", DPoP algs="ES256 PS256", error="use_dpop_nonce", error_description="fresh \\"nonce\\"", Bearer resource_metadata="https://api.test/.well-known/oauth-protected-resource", scope="a b"';
  const all = parseWwwAuthenticate(header);
  assertEquals(all.map((c) => c.scheme), ["Basic", "DPoP", "Bearer"]);
  assertEquals(all[1].params.error_description, 'fresh "nonce"');
  const dpop = resourceChallenge(header)!;
  assertEquals(dpop.scheme, "DPoP");
  assertEquals(dpop.algs, ["ES256", "PS256"]);
  assertEquals(dpop.error, "use_dpop_nonce");
  const bearer = resourceChallenge(header, "Bearer")!;
  assertEquals(bearer.scopes, ["a", "b"]);
  assertEquals(
    bearer.resourceMetadata,
    "https://api.test/.well-known/oauth-protected-resource",
  );
  assertEquals(resourceChallenge(null), null);
  assertEquals(resourceChallenge("Basic realm=x"), null);
  assertEquals(parseWwwAuthenticate("Negotiate abc123=="), [
    { scheme: "Negotiate", params: {}, token68: "abc123==" },
  ]);
});

Deno.test("challenges: formatting escapes and drops what a header cannot carry", () => {
  assertEquals(
    formatChallenge("Bearer", {
      error: "invalid_token",
      error_description: 'bad "token"\r\nInjected: yes',
      scope: undefined,
    }),
    'Bearer error="invalid_token", error_description="bad \\"token\\"Injected: yes"',
  );
  assertEquals(formatChallenge("DPoP", {}), "DPoP");
  let threw = false;
  try {
    formatChallenge("Bad Scheme", {});
  } catch {
    threw = true;
  }
  assert(threw, "a scheme with a space is refused");
  const round = parseWwwAuthenticate(
    formatChallenge("Bearer", { error_description: 'a "b" \\c' }),
  );
  assertEquals(round[0].params.error_description, 'a "b" \\c');
});

Deno.test("errors: protocol errors are RFC 6749 section 5.2 responses", async () => {
  const error = new ProtocolError("invalid_grant", {
    description: "the code expired\n",
  });
  assertEquals(error.status, 400);
  assertEquals(error.toJSON(), {
    error: "invalid_grant",
    error_description: "the code expired?",
  });
  const response = error.toResponse();
  assertEquals(response.status, 400);
  assertEquals(response.headers.get("cache-control"), "no-store");
  assertEquals(response.headers.get("content-type"), "application/json");
  assertEquals(await response.json(), error.toJSON());
  assertEquals(new ProtocolError("invalid_client").status, 401);
  assertEquals(safeDescription('quote " and \\'), "quote ? and ?");
});

Deno.test("errors: client errors survive a plain-data round trip", async () => {
  const error = new OAuthError("token", "refused", {
    error: "invalid_grant",
    status: 400,
    issuer: "https://as.test",
  });
  const again = oauthErrorFromData(JSON.parse(JSON.stringify(error.toJSON())));
  assertEquals(again.toJSON(), error.toJSON());
  assert(!again.retryable, "invalid_grant is not retryable");
  assert(
    new OAuthError("network", "down").retryable,
    "network errors are retryable",
  );
  const outcome = await attemptOAuth(() => Promise.reject(error));
  assertEquals(outcome.ok, false);
  let rethrown = false;
  try {
    await attemptOAuth(() => Promise.reject(new TypeError("bug")));
  } catch {
    rethrown = true;
  }
  assert(rethrown, "other errors are rethrown");
});

Deno.test("URLs: https everywhere, http only on loopback", () => {
  assertEquals(secureUrlProblem("https://as.example.com/"), null);
  assertEquals(secureUrlProblem("http://127.0.0.1:8080/x"), null);
  assertEquals(secureUrlProblem("http://127.9.9.9/"), null);
  assertEquals(secureUrlProblem("http://[::1]:3000/"), null);
  assertEquals(secureUrlProblem("http://localhost/"), null);
  assertEquals(secureUrlProblem("http://app.localhost/"), null);
  assert(secureUrlProblem("http://as.example.com/") !== null, "plain http");
  assert(secureUrlProblem("http://128.0.0.1/") !== null, "not loopback");
  assert(secureUrlProblem("https://as.example.com/#f") !== null, "fragment");
  assert(secureUrlProblem("https://u:p@as.example.com/") !== null, "userinfo");
  assert(secureUrlProblem("/relative") !== null, "relative");
  assert(isLoopbackHost("[::ffff:127.0.0.1]"), "v4-mapped loopback");
  assert(!isLoopbackHost("localhost.example.com"), "a suffix is not loopback");
  assert(isIssuer("https://as.example.com/tenant"), "a path is fine");
  assert(!isIssuer("https://as.example.com/?q=1"), "a query is not");
  let threw = false;
  try {
    checkSecureUrl("http://as.example.com", "issuer");
  } catch (error) {
    threw = error instanceof TypeError;
  }
  assert(threw, "checkSecureUrl throws a TypeError");
});

Deno.test("metadata URLs: RFC 8414 section 3.1 and OpenID fallbacks", () => {
  assertEquals(authorizationServerMetadataUrls("https://example.com"), [
    "https://example.com/.well-known/oauth-authorization-server",
    "https://example.com/.well-known/openid-configuration",
  ]);
  assertEquals(
    authorizationServerMetadataUrls("https://example.com/issuer1"),
    [
      "https://example.com/.well-known/oauth-authorization-server/issuer1",
      "https://example.com/.well-known/openid-configuration/issuer1",
      "https://example.com/issuer1/.well-known/openid-configuration",
    ],
  );
  assertEquals(
    authorizationServerMetadataUrls("https://example.com/issuer1", {
      oidc: false,
    }),
    ["https://example.com/.well-known/oauth-authorization-server/issuer1"],
  );
});

Deno.test("metadata URLs: RFC 9728 section 3.1", () => {
  assertEquals(
    protectedResourceMetadataUrl("https://resource.example.com"),
    "https://resource.example.com/.well-known/oauth-protected-resource",
  );
  assertEquals(
    protectedResourceMetadataUrl("https://resource.example.com/resource1"),
    "https://resource.example.com/.well-known/oauth-protected-resource/resource1",
  );
  assertEquals(
    protectedResourceMetadataUrl("https://resource.example.com/r/?x=1"),
    "https://resource.example.com/.well-known/oauth-protected-resource/r?x=1",
  );
  assertEquals(
    protectedResourceMetadataUrls("https://api.test/v1/files?page=2"),
    [
      "https://api.test/.well-known/oauth-protected-resource/v1/files",
      "https://api.test/.well-known/oauth-protected-resource",
    ],
  );
});

Deno.test("resources: canonical form and coverage", () => {
  assertEquals(
    canonicalResource("HTTPS://API.Example.com/"),
    "https://api.example.com",
  );
  assertEquals(
    canonicalResource("https://api.example.com/v1/"),
    "https://api.example.com/v1",
  );
  assert(
    resourceCovers("https://api.test/v1", "https://api.test/v1/files"),
    "a path under it",
  );
  assert(
    resourceCovers("https://api.test", "https://api.test/anything"),
    "the origin",
  );
  assert(
    !resourceCovers("https://api.test/v1", "https://api.test/v10"),
    "not a segment boundary",
  );
  assert(
    !resourceCovers("https://api.test/v1", "https://evil.test/v1"),
    "another origin",
  );
  assert(
    !resourceCovers("https://api.test/v1", "https://api.test/v1/files", {
      exact: true,
    }),
    "exact wants the same URL",
  );
  assert(
    resourceCovers("https://api.test/v1/", "https://api.test/v1", {
      exact: true,
    }),
    "a trailing slash is not a difference",
  );
});

Deno.test("Basic credentials are form-encoded both ways (RFC 6749 section 2.3.1)", () => {
  const header = basicAuthorization("client:1", "sécret +/");
  assertEquals(
    header,
    `Basic ${btoa("client%3A1:s%C3%A9cret+%2B%2F")}`,
  );
  assertEquals(parseBasicAuthorization(header), {
    clientId: "client:1",
    secret: "sécret +/",
  });
  assertEquals(parseBasicAuthorization("Bearer x"), null);
  assertEquals(parseBasicAuthorization(`Basic ${btoa("nocolon")}`), null);
  assertEquals(parseBasicAuthorization(null), null);
});

Deno.test("scopes and constant-time comparison", () => {
  assertEquals(parseScope(" a  b a c "), ["a", "b", "c"]);
  assertEquals(parseScope(undefined), []);
  assert(timingSafeEqual("abc", "abc"), "equal");
  assert(!timingSafeEqual("abc", "abd"), "different");
  assert(!timingSafeEqual("abc", "abcd"), "different lengths");
  assert(!timingSafeEqual("", "a"), "empty");
});

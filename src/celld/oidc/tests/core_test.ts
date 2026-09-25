// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

import { assert, assertEquals } from "@celld/assert";
import {
  checkOpenIdProviderMetadata,
  claimsForScopes,
  ClaimsRequestError,
  discoverOpenIdProvider,
  hashForAlgorithm,
  openIdConfigurationUrl,
  parseClaimsRequest,
  requestedAcrValues,
  tokenHash,
} from "@celld/oidc";
import {
  clearCookie,
  CookieSealer,
  isLocalPath,
  readCookie,
  setCookie,
} from "@celld/oidc/rp";
import { routeFetch } from "@celld/oauth/testing";
import { clock, rejects } from "./fixture.ts";

Deno.test("left-half hashes follow the alg's hash", async () => {
  assertEquals(hashForAlgorithm("ES256"), "SHA-256");
  assertEquals(hashForAlgorithm("PS384"), "SHA-384");
  assertEquals(hashForAlgorithm("RS512"), "SHA-512");
  assertEquals(hashForAlgorithm("EdDSA"), "SHA-512");
  assertEquals(hashForAlgorithm("none"), null);
  assertEquals((await tokenHash("x", "ES256")).length, 22);
  assertEquals((await tokenHash("x", "ES384")).length, 32);
  assertEquals((await tokenHash("x", "ES512")).length, 43);
  await rejects(() => tokenHash("x", "none"), { name: "TypeError" });
});

Deno.test("scopes map to the standard claims", () => {
  assertEquals(claimsForScopes(["openid", "email"]), [
    "email",
    "email_verified",
  ]);
  assertEquals(claimsForScopes(["phone", "address", "phone"]), [
    "phone_number",
    "phone_number_verified",
    "address",
  ]);
  assert(
    claimsForScopes(["profile"]).includes("preferred_username"),
    "profile",
  );
  assertEquals(claimsForScopes(["files:read"]), []);
});

Deno.test("the claims parameter: the Core 5.5 example and malformed ones", () => {
  const parsed = parseClaimsRequest(JSON.stringify({
    userinfo: {
      given_name: { essential: true },
      nickname: null,
      email: { essential: true },
      email_verified: { essential: true },
      picture: null,
      "http://example.info/claims/groups": null,
    },
    id_token: {
      auth_time: { essential: true },
      acr: { values: ["urn:mace:incommon:iap:silver"] },
    },
    other: 1,
  }));
  assertEquals(Object.keys(parsed.userinfo!).length, 6);
  assertEquals(parsed.id_token!.auth_time, { essential: true });
  assertEquals("other" in parsed, false);
  for (
    const bad of [
      "not json",
      "[]",
      '{"userinfo": []}',
      '{"id_token": {"acr": 1}}',
      '{"id_token": {"acr": {"essential": "yes"}}}',
      '{"id_token": {"acr": {"values": "x"}}}',
    ]
  ) {
    let threw = false;
    try {
      parseClaimsRequest(bad);
    } catch (error) {
      threw = error instanceof ClaimsRequestError;
    }
    assert(threw, `${bad} must be refused`);
  }
});

Deno.test("acr: an essential claim request beats acr_values", () => {
  assertEquals(requestedAcrValues(undefined, "urn:a urn:b"), {
    values: ["urn:a", "urn:b"],
    essential: false,
  });
  assertEquals(
    requestedAcrValues(
      { id_token: { acr: { essential: true, values: ["urn:c"] } } },
      "urn:a",
    ),
    { values: ["urn:c"], essential: true },
  );
  assertEquals(
    requestedAcrValues({ id_token: { acr: { value: "urn:d" } } }, undefined),
    { values: ["urn:d"], essential: false },
  );
});

const METADATA = {
  issuer: "https://op.test/tenant",
  authorization_endpoint: "https://op.test/tenant/authorize",
  token_endpoint: "https://op.test/tenant/token",
  jwks_uri: "https://op.test/tenant/jwks",
  userinfo_endpoint: "https://op.test/tenant/userinfo",
  response_types_supported: ["code"],
  subject_types_supported: ["public"],
  id_token_signing_alg_values_supported: ["ES256"],
};

Deno.test("provider metadata: what Discovery requires", () => {
  assertEquals(
    openIdConfigurationUrl("https://op.test/tenant/"),
    "https://op.test/tenant/.well-known/openid-configuration",
  );
  const ok = checkOpenIdProviderMetadata(METADATA, METADATA.issuer);
  assertEquals(typeof ok, "object");
  const problems: [Record<string, unknown>, string][] = [
    [{ issuer: "https://evil.test" }, "is not"],
    [{ jwks_uri: undefined }, "jwks_uri is required"],
    [
      { subject_types_supported: undefined },
      "subject_types_supported is required",
    ],
    [{ response_types_supported: ["id_token"] }, "code response type"],
    [{ id_token_signing_alg_values_supported: ["none", "RS256"] }, "none"],
    [{ userinfo_endpoint: "http://op.test/userinfo" }, "https"],
  ];
  for (const [change, message] of problems) {
    const result = checkOpenIdProviderMetadata(
      { ...METADATA, ...change },
      METADATA.issuer,
    );
    assert(
      typeof result === "string" && result.includes(message),
      `${JSON.stringify(change)} gave ${JSON.stringify(result)}`,
    );
  }
});

Deno.test("discovery reads the appended location first and never another issuer's", async () => {
  const fetch = routeFetch({
    "https://op.test": (request) => {
      const path = new URL(request.url).pathname;
      if (path === "/tenant/.well-known/openid-configuration") {
        return Response.json(METADATA);
      }
      return new Response("no", { status: 404 });
    },
  });
  const found = await discoverOpenIdProvider(METADATA.issuer, { fetch });
  assertEquals(found.userinfo_endpoint, METADATA.userinfo_endpoint);
  assertEquals(fetch.requests.length, 1);
  const liar = routeFetch({
    "https://op.test": () =>
      Response.json({ ...METADATA, issuer: "https://op.test" }),
  });
  await rejects(
    () => discoverOpenIdProvider(METADATA.issuer, { fetch: liar }),
    {
      kind: "discovery",
    },
  );
  const down = routeFetch({
    "https://op.test": () => new Response("down", { status: 503 }),
  });
  await rejects(
    () => discoverOpenIdProvider(METADATA.issuer, { fetch: down }),
    {
      kind: "network",
    },
  );
});

Deno.test("sealed cookies: round trip, tamper, move, expiry, rotation", async () => {
  const time = clock();
  const secret = "cookie-secret-0123456789abcdefghijkl";
  const sealer = await CookieSealer.create({ secret, now: time.now });
  const sealed = await sealer.seal("login", { state: "s", n: 1 }, 60);
  assertEquals(await sealer.unseal("login", sealed), { state: "s", n: 1 });
  assertEquals(await sealer.unseal("session", sealed), null, "moved cookie");
  const flipped = sealed.slice(0, -2) + (sealed.endsWith("A") ? "BB" : "AA");
  assertEquals(await sealer.unseal("login", flipped), null, "tampered");
  assertEquals(await sealer.unseal("login", "v1.x.y"), null, "garbage");
  assertEquals(await sealer.unseal("login", null), null);
  const rotated = await CookieSealer.create({
    secret: "a-newer-cookie-secret-0123456789abcd",
    previous: [secret],
    now: time.now,
  });
  assertEquals(await rotated.unseal("login", sealed), { state: "s", n: 1 });
  time.advance(61_000);
  assertEquals(await sealer.unseal("login", sealed), null, "expired");
  await rejects(() => CookieSealer.create({ secret: "short" }), {
    name: "TypeError",
  });
});

Deno.test("cookie headers and local paths", () => {
  assertEquals(
    setCookie("__Host-a", "v", { maxAgeSec: 60 }),
    "__Host-a=v; Path=/; Max-Age=60; Secure; HttpOnly; SameSite=Lax",
  );
  assertEquals(
    clearCookie("a", { secure: false }),
    "a=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax",
  );
  assertEquals(readCookie("x=1; a=two; b=3", "a"), "two");
  assertEquals(readCookie("x=1", "a"), null);
  assertEquals(isLocalPath("/account?tab=1"), true);
  assertEquals(isLocalPath("//evil.test/"), false);
  assertEquals(isLocalPath("/\\evil.test"), false);
  assertEquals(isLocalPath("https://evil.test/"), false);
  let threw = false;
  try {
    setCookie("a", "v;injected=1");
  } catch {
    threw = true;
  }
  assert(threw, "a value with ; is refused");
});

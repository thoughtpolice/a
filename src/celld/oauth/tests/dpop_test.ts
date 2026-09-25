// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

import { assert, assertEquals } from "@celld/assert";
import {
  decode,
  generateKeyPair,
  generateSecret,
  jwkThumbprint,
  sign,
} from "@celld/jwt";
import {
  accessTokenHash,
  DpopError,
  DpopKey,
  DpopNonceCache,
  DpopNonceIssuer,
  htuMatches,
  memoryReplayStore,
  normalizeHtu,
  singleDpopHeader,
  verifyDpopProof,
} from "@celld/oauth/dpop";
import { rejects, withUnsupportedVerify } from "./fixture.ts";

// RFC 9449 figure 2 (section 4.1), with the RFC 8792 line folding undone.
const RFC_TOKEN_PROOF =
  "eyJ0eXAiOiJkcG9wK2p3dCIsImFsZyI6IkVTMjU2IiwiandrIjp7Imt0eSI6IkVDIiwieCI6Imw4dEZyaHgtMzR0VjNoUklDUkRZOXpDa0RscEJoRjQyVVFVZldWQVdCRnMiLCJ5IjoiOVZFNGpmX09rX282NHpiVFRsY3VOSmFqSG10NnY5VERWclUwQ2R2R1JEQSIsImNydiI6IlAtMjU2In19.eyJqdGkiOiItQndDM0VTYzZhY2MybFRjIiwiaHRtIjoiUE9TVCIsImh0dSI6Imh0dHBzOi8vc2VydmVyLmV4YW1wbGUuY29tL3Rva2VuIiwiaWF0IjoxNTYyMjYyNjE2fQ.2-GxA6T8lP4vfrg8v-FdWP0A0zdrj8igiMLvqRMUvwnQg4PtFLbdLXiOSsX0x7NVY-FNyJK70nfbV37xRZT3Lg";

// RFC 9449 figure 13 (section 7.1): a proof for a protected resource request.
const RFC_RESOURCE_PROOF =
  "eyJ0eXAiOiJkcG9wK2p3dCIsImFsZyI6IkVTMjU2IiwiandrIjp7Imt0eSI6IkVDIiwieCI6Imw4dEZyaHgtMzR0VjNoUklDUkRZOXpDa0RscEJoRjQyVVFVZldWQVdCRnMiLCJ5IjoiOVZFNGpmX09rX282NHpiVFRsY3VOSmFqSG10NnY5VERWclUwQ2R2R1JEQSIsImNydiI6IlAtMjU2In19.eyJqdGkiOiJlMWozVl9iS2ljOC1MQUVCIiwiaHRtIjoiR0VUIiwiaHR1IjoiaHR0cHM6Ly9yZXNvdXJjZS5leGFtcGxlLm9yZy9wcm90ZWN0ZWRyZXNvdXJjZSIsImlhdCI6MTU2MjI2MjYxOCwiYXRoIjoiZlVIeU8ycjJaM0RaNTNFc05yV0JiMHhXWG9hTnk1OUlpS0NBcWtzbVFFbyJ9.2oW9RP35yRqzhrtNP86L-Ey71EOptxRimPPToA1plemAgR6pxHF8y6-yqyVnmcw6Fy1dqd-jfxSYoMxhAJpLjA";
const RFC_ACCESS_TOKEN = "Kz~8mXK1EalYznwH-LC-1fBAo.4Ljp~zsPE_NeO.gxU";
const RFC_JKT = "0ZcOCORZNYy-DWpqq30jZyJGHTN0d2HglBV3uiguA4I";

async function refused(
  work: Promise<unknown>,
  code: "invalid_dpop_proof" | "use_dpop_nonce" = "invalid_dpop_proof",
  message?: string,
): Promise<void> {
  try {
    await work;
  } catch (error) {
    assert(error instanceof DpopError, `expected a DpopError, got ${error}`);
    assertEquals(error.code, code);
    if (message !== undefined) {
      assert(
        error.message.includes(message),
        `"${error.message}" should mention "${message}"`,
      );
    }
    return;
  }
  throw new Error("expected the proof to be refused");
}

Deno.test("RFC 9449: the token request proof of figure 2 verifies", async () => {
  const verified = await verifyDpopProof(RFC_TOKEN_PROOF, {
    method: "POST",
    url: "https://server.example.com/token",
    now: () => 1562262616_000,
  });
  assertEquals(verified.jkt, RFC_JKT);
  assertEquals(verified.alg, "ES256");
  assertEquals(verified.claims.jti, "-BwC3ESc6acc2lTc");
  // Figure 4's decoded header.
  assertEquals(decode(RFC_TOKEN_PROOF).header.jwk, {
    kty: "EC",
    x: "l8tFrhx-34tV3hRICRDY9zCkDlpBhF42UQUfWVAWBFs",
    y: "9VE4jf_Ok_o64zbTTlcuNJajHmt6v9TDVrU0CdvGRDA",
    crv: "P-256",
  });
});

Deno.test("RFC 9449: the jkt of section 6.1 and the ath of section 7.1", async () => {
  assertEquals(
    await jwkThumbprint({
      kty: "EC",
      x: "l8tFrhx-34tV3hRICRDY9zCkDlpBhF42UQUfWVAWBFs",
      y: "9VE4jf_Ok_o64zbTTlcuNJajHmt6v9TDVrU0CdvGRDA",
      crv: "P-256",
    }),
    RFC_JKT,
  );
  assertEquals(
    await accessTokenHash(RFC_ACCESS_TOKEN),
    "fUHyO2r2Z3DZ53EsNrWBb0xWXoaNy59IiKCAqksmQEo",
  );
});

Deno.test("RFC 9449: the resource request proof of figure 13 verifies with ath and jkt", async () => {
  const options = {
    method: "GET",
    url: "https://resource.example.org/protectedresource",
    accessToken: RFC_ACCESS_TOKEN,
    jkt: RFC_JKT,
    now: () => 1562262618_000,
  };
  const verified = await verifyDpopProof(RFC_RESOURCE_PROOF, options);
  assertEquals(
    verified.claims.ath,
    "fUHyO2r2Z3DZ53EsNrWBb0xWXoaNy59IiKCAqksmQEo",
  );
  await refused(
    verifyDpopProof(RFC_RESOURCE_PROOF, { ...options, accessToken: "other" }),
    "invalid_dpop_proof",
    "ath",
  );
  await refused(
    verifyDpopProof(RFC_RESOURCE_PROOF, { ...options, jkt: "x".repeat(43) }),
    "invalid_dpop_proof",
    "bound",
  );
  // A runtime that cannot verify the proof's algorithm is not a bad proof.
  await rejects(
    () =>
      withUnsupportedVerify(() => verifyDpopProof(RFC_RESOURCE_PROOF, options)),
    { name: "JwtError", code: "runtime_unsupported" },
  );
  await refused(
    verifyDpopProof(RFC_RESOURCE_PROOF, { ...options, method: "POST" }),
    "invalid_dpop_proof",
    "htm",
  );
  await refused(
    verifyDpopProof(RFC_RESOURCE_PROOF, {
      ...options,
      url: "https://resource.example.org/other",
    }),
    "invalid_dpop_proof",
    "htu",
  );
  await refused(
    verifyDpopProof(RFC_RESOURCE_PROOF, {
      ...options,
      now: () => (1562262618 + 3600) * 1000,
    }),
    "invalid_dpop_proof",
    "iat",
  );
  // A tampered signature.
  await refused(
    verifyDpopProof(RFC_RESOURCE_PROOF.slice(0, -2) + "AA", options),
  );
});

Deno.test("htu: normalization and comparison", () => {
  assertEquals(
    normalizeHtu("HTTPS://Server.Example.COM:443/a/./b/../token?x=1#frag"),
    "https://server.example.com/a/token",
  );
  assertEquals(normalizeHtu("http://h.test:80"), "http://h.test/");
  assertEquals(
    normalizeHtu("https://h.test/%7euser/%2f"),
    "https://h.test/~user/%2F",
  );
  assert(
    htuMatches("https://h.test/%7Euser", "https://h.test/~user?q=1"),
    "percent-encoded unreserved characters match",
  );
  assert(
    htuMatches("https://h.test:443/x", "https://h.test/x"),
    "default port",
  );
  assert(!htuMatches("https://h.test/x", "http://h.test/x"), "scheme");
  assert(!htuMatches("https://h.test/x", "https://h.test/X"), "path case");
  assert(!htuMatches(42, "https://h.test/x"), "not a string");
  assert(!htuMatches("not a url", "https://h.test/x"), "not a URL");
});

Deno.test("DpopKey: proofs carry what RFC 9449 section 4.2 asks", async () => {
  const now = () => 1_800_000_000_000;
  const key = await DpopKey.generate({ now });
  assertEquals(key.alg, "ES256");
  assertEquals(key.jkt, await jwkThumbprint(key.publicJwk));
  assertEquals(Object.keys(key.publicJwk).sort(), ["crv", "kty", "x", "y"]);
  const proof = await key.proof({
    method: "GET",
    url: "https://api.test/files?page=2#top",
    accessToken: "token-1",
    nonce: "n-1",
    claims: { htm: "POST", extra: true },
  });
  const { header, payload } = decode(proof);
  assertEquals(header.typ, "dpop+jwt");
  assertEquals(header.alg, "ES256");
  assertEquals(header.jwk, key.publicJwk);
  assertEquals(payload.htm, "GET");
  assertEquals(payload.htu, "https://api.test/files");
  assertEquals(payload.iat, 1_800_000_000);
  assertEquals(payload.nonce, "n-1");
  assertEquals(payload.extra, true);
  assertEquals(payload.ath, await accessTokenHash("token-1"));
  assertEquals((payload.jti as string).length, 22);
  const verified = await verifyDpopProof(proof, {
    method: "GET",
    url: "https://api.test/files",
    accessToken: "token-1",
    jkt: key.jkt,
    now,
  });
  assertEquals(verified.jkt, key.jkt);
  const second = await key.proof({
    method: "GET",
    url: "https://api.test/files",
  });
  assert(
    decode(second).payload.jti !== payload.jti,
    "every proof has its own jti",
  );
});

Deno.test("DpopKey: other algorithms, export and reload", async () => {
  const rsa = await DpopKey.generate({ alg: "PS256" });
  assertEquals(rsa.publicJwk.kty, "RSA");
  await verifyDpopProof(
    await rsa.proof({ method: "POST", url: "https://as.test/token" }),
    { method: "POST", url: "https://as.test/token" },
  );
  const kept = await DpopKey.generate({ extractable: true });
  const jwk = await kept.exportPrivateJwk();
  const again = await DpopKey.fromPrivateJwk(jwk, "ES256");
  assertEquals(again.jkt, kept.jkt);
  let threw = false;
  try {
    await (await DpopKey.generate()).exportPrivateJwk();
  } catch {
    threw = true;
  }
  assert(threw, "a key that is not extractable cannot be exported");
  threw = false;
  try {
    // deno-lint-ignore no-explicit-any
    await DpopKey.generate({ alg: "HS256" as any });
  } catch {
    threw = true;
  }
  assert(threw, "HMAC is not a DPoP algorithm");
});

Deno.test("EdDSA proofs are refused unless the verifier allows them", async () => {
  const key = await DpopKey.generate({ alg: "EdDSA" });
  const proof = await key.proof({
    method: "POST",
    url: "https://as.test/token",
  });
  await refused(
    verifyDpopProof(proof, { method: "POST", url: "https://as.test/token" }),
    "invalid_dpop_proof",
    "alg",
  );
  const verified = await verifyDpopProof(proof, {
    method: "POST",
    url: "https://as.test/token",
    algorithms: ["EdDSA"],
  });
  assertEquals(verified.alg, "EdDSA");
});

async function handmade(
  header: Record<string, unknown>,
  claims: Record<string, unknown>,
  alg: "ES256" | "HS256" = "ES256",
): Promise<string> {
  if (alg === "HS256") {
    return await sign(claims, generateSecret("HS256"), {
      alg,
      typ: null,
      header,
    });
  }
  const pair = await generateKeyPair("ES256", { extractable: true });
  return await sign(claims, pair.privateKey, {
    alg,
    typ: null,
    header: { jwk: pair.publicJwk, ...header },
  });
}

Deno.test("verification refuses malformed proofs (RFC 9449 section 4.3)", async () => {
  const now = () => 1_800_000_000_000;
  const claims = {
    jti: "j1",
    htm: "POST",
    htu: "https://as.test/token",
    iat: 1_800_000_000,
  };
  const options = { method: "POST", url: "https://as.test/token", now };
  await refused(
    verifyDpopProof("not.a.jwt", options),
    "invalid_dpop_proof",
    "JWT",
  );
  await refused(
    verifyDpopProof(await handmade({ typ: "JWT" }, claims), options),
    "invalid_dpop_proof",
    "typ",
  );
  await refused(
    verifyDpopProof(
      await handmade(
        { typ: "dpop+jwt", jwk: { kty: "oct", k: "AAAA" } },
        claims,
        "HS256",
      ),
      options,
    ),
    "invalid_dpop_proof",
    "alg",
  );
  const pair = await generateKeyPair("ES256", { extractable: true });
  const privateJwk = await crypto.subtle.exportKey("jwk", pair.privateKey);
  await refused(
    verifyDpopProof(
      await sign(claims, pair.privateKey, {
        alg: "ES256",
        typ: "dpop+jwt",
        header: { jwk: privateJwk },
      }),
      options,
    ),
    "invalid_dpop_proof",
    "private",
  );
  await refused(
    verifyDpopProof(
      await sign(claims, pair.privateKey, { alg: "ES256", typ: "dpop+jwt" }),
      options,
    ),
    "invalid_dpop_proof",
    "jwk",
  );
  const other = await generateKeyPair("ES256");
  await refused(
    verifyDpopProof(
      await sign(claims, pair.privateKey, {
        alg: "ES256",
        typ: "dpop+jwt",
        header: { jwk: other.publicJwk },
      }),
      options,
    ),
    "invalid_dpop_proof",
    "signature",
  );
  const { jti: _jti, ...noJti } = claims;
  await refused(
    verifyDpopProof(await handmade({ typ: "dpop+jwt" }, noJti), options),
    "invalid_dpop_proof",
    "jti",
  );
  await refused(
    verifyDpopProof(
      await handmade({ typ: "dpop+jwt" }, {
        ...claims,
        iat: 1_800_000_000 - 120,
      }),
      options,
    ),
    "invalid_dpop_proof",
    "past",
  );
  await refused(
    verifyDpopProof(
      await handmade({ typ: "dpop+jwt" }, {
        ...claims,
        iat: 1_800_000_000 + 60,
      }),
      options,
    ),
    "invalid_dpop_proof",
    "future",
  );
  await refused(
    verifyDpopProof(
      await handmade({ typ: "dpop+jwt" }, claims),
      { ...options, accessToken: "t" },
    ),
    "invalid_dpop_proof",
    "ath",
  );
  await refused(
    verifyDpopProof("a".repeat(9000), options),
    "invalid_dpop_proof",
    "long",
  );
  // Within the window and tolerance it passes.
  await verifyDpopProof(
    await handmade({ typ: "dpop+jwt" }, { ...claims, iat: 1_800_000_000 + 4 }),
    options,
  );
});

Deno.test("replay: a proof is accepted once", async () => {
  const key = await DpopKey.generate();
  const replay = memoryReplayStore();
  const proof = await key.proof({
    method: "POST",
    url: "https://as.test/token",
  });
  const options = { method: "POST", url: "https://as.test/token", replay };
  await verifyDpopProof(proof, options);
  await refused(
    verifyDpopProof(proof, options),
    "invalid_dpop_proof",
    "used before",
  );
  // A refused proof does not spend its jti.
  const second = await key.proof({
    method: "POST",
    url: "https://as.test/token",
  });
  await refused(verifyDpopProof(second, { ...options, method: "GET" }));
  await verifyDpopProof(second, options);
});

Deno.test("replay: the memory store forgets expired entries and stays bounded", async () => {
  let now = 0;
  const store = memoryReplayStore({ now: () => now, maxEntries: 2 });
  assert(await store.claim("a", 100), "first a");
  assert(!(await store.claim("a", 100)), "a again");
  now = 100;
  assert(await store.claim("a", 200), "a after expiry");
  assert(await store.claim("b", 200), "b");
  assert(await store.claim("c", 200), "c evicts the oldest");
});

Deno.test("nonces: required, checked, rotated", async () => {
  let now = 1_000_000;
  const issuer = await DpopNonceIssuer.create({
    secret: "0123456789abcdef0123456789abcdef",
    lifetimeSec: 60,
    now: () => now,
  });
  const nonce = await issuer.current();
  assert(await issuer.check(nonce), "a current nonce passes");
  const twin = await DpopNonceIssuer.create({
    secret: "0123456789abcdef0123456789abcdef",
    lifetimeSec: 60,
    now: () => now,
  });
  assertEquals(await twin.current(), nonce);
  const stranger = await DpopNonceIssuer.create({ now: () => now });
  assert(!(await stranger.check(nonce)), "another secret's nonce fails");
  now += 30_000;
  assert(await issuer.check(nonce), "the previous slot still passes");
  assert((await issuer.current()) !== nonce, "a new slot has a new nonce");
  now += 30_000;
  assert(!(await issuer.check(nonce)), "two slots on, it is stale");
  assert(!(await issuer.check("garbage")), "garbage fails");

  const key = await DpopKey.generate({ now: () => now });
  const target = { method: "POST", url: "https://as.test/token" };
  const options = { ...target, nonce: issuer, now: () => now };
  await refused(
    verifyDpopProof(await key.proof(target), options),
    "use_dpop_nonce",
    "needs a nonce",
  );
  await refused(
    verifyDpopProof(await key.proof({ ...target, nonce }), options),
    "use_dpop_nonce",
    "stale",
  );
  await verifyDpopProof(
    await key.proof({ ...target, nonce: await issuer.current() }),
    options,
  );
  let threw = false;
  try {
    await DpopNonceIssuer.create({ secret: "short" });
  } catch {
    threw = true;
  }
  assert(threw, "a short secret is refused");
});

Deno.test("nonce cache: per origin, from DPoP-Nonce headers", () => {
  const cache = new DpopNonceCache();
  assertEquals(
    cache.update("https://as.test/token", new Headers({ "dpop-nonce": "n1" })),
    "n1",
  );
  assertEquals(cache.get("https://as.test/par"), "n1");
  assertEquals(cache.get("https://api.test/x"), undefined);
  assertEquals(
    cache.update(
      "https://api.test/x",
      new Response(null, { headers: { "dpop-nonce": "bad nonce" } }),
    ),
    undefined,
  );
});

Deno.test("headers: exactly one DPoP header", () => {
  assertEquals(singleDpopHeader(new Headers()), null);
  assertEquals(singleDpopHeader(new Headers({ dpop: " a.b.c " })), "a.b.c");
  const two = new Headers();
  two.append("dpop", "a.b.c");
  two.append("dpop", "d.e.f");
  let threw = false;
  try {
    singleDpopHeader(two);
  } catch (error) {
    threw = error instanceof DpopError;
  }
  assert(threw, "two headers are refused");
});

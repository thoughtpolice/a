// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

import { assert, assertEquals } from "@celld/assert";
import {
  decode,
  generateKeyPair,
  generateSecret,
  importJwk,
  JWS_ALGORITHMS,
  type JwtClaims,
  localJwks,
  sign,
  toBase64Url,
  verify,
  verifyBytes,
} from "@celld/jwt";
import { part, rejects } from "./fixture.ts";

const NOW = 1_790_000_000_000;
const now = () => NOW;
const secs = NOW / 1000;

Deno.test("sign then verify, every algorithm", async () => {
  for (const alg of JWS_ALGORITHMS) {
    const keys = alg.startsWith("HS")
      ? { signer: generateSecret(alg), verifier: undefined }
      : await generateKeyPair(alg).then((pair) => ({
        signer: pair.privateKey,
        verifier: pair.publicKey,
      }));
    const token = await sign({ sub: "alice" }, keys.signer, { alg, kid: "k" });
    const verified = await verify(token, keys.verifier ?? keys.signer, { now });
    assertEquals(verified.alg, alg);
    assertEquals(verified.payload, { sub: "alice" });
    assertEquals(verified.header, { alg, typ: "JWT", kid: "k" });
  }
});

Deno.test("sign sets time claims and header", async () => {
  const secret = generateSecret("HS256");
  const token = await sign({ sub: "a", exp: 1 }, secret, {
    alg: "HS256",
    typ: "at+jwt",
    header: { alg: "none", x: 1 },
    issuedAt: true,
    expiresIn: 60,
    notBefore: 0,
    now,
  });
  const { header, payload } = decode(token);
  assertEquals(header, { alg: "HS256", typ: "at+jwt", x: 1 });
  assertEquals(payload, { sub: "a", exp: secs + 60, iat: secs, nbf: secs });
  const bare = await sign({}, secret, { alg: "HS256", typ: null });
  assertEquals(decode(bare).header, { alg: "HS256" });
  await rejects(
    () => sign({}, secret, { alg: "none" as "HS256" }),
    "unsupported_alg",
  );
});

Deno.test("alg none and unknown algorithms are refused", async () => {
  const secret = generateSecret("HS256");
  const none = `${part({ alg: "none" })}.${part({ sub: "a" })}.`;
  await rejects(() => verify(none, secret), "unsupported_alg");
  const upper = `${part({ alg: "NONE" })}.${part({ sub: "a" })}.`;
  await rejects(() => verify(upper, secret), "unsupported_alg");
  const other = `${part({ alg: "HS1" })}.${part({ sub: "a" })}.c2ln`;
  await rejects(() => verify(other, secret), "unsupported_alg");
  await rejects(() => verify("x.y", secret), "malformed");
});

Deno.test("the algorithm allow-list", async () => {
  const pair = await generateKeyPair("ES256");
  const token = await sign({}, pair.privateKey, { alg: "ES256" });
  await verify(token, pair.publicKey, { algorithms: ["ES256"] });
  await rejects(
    () => verify(token, pair.publicKey, { algorithms: ["RS256"] }),
    "alg_not_allowed",
  );
});

Deno.test("algorithm confusion: an RSA public key is not an HMAC secret", async () => {
  const pair = await generateKeyPair("RS256", { extractable: true });
  const spki = new Uint8Array(
    await crypto.subtle.exportKey("spki", pair.publicKey),
  );
  const forged = await sign({ sub: "admin" }, spki, { alg: "HS256" });
  await rejects(() => verify(forged, pair.publicKey), "key_mismatch");
  await rejects(() => verify(forged, pair.publicJwk), "key_mismatch");
  await rejects(() => verify(forged, { keys: [pair.publicJwk] }), "no_key");
});

Deno.test("signatures", async () => {
  const pair = await generateKeyPair("EdDSA");
  const other = await generateKeyPair("EdDSA");
  const token = await sign({ sub: "a" }, pair.privateKey, { alg: "EdDSA" });
  await rejects(() => verify(token, other.publicKey), "bad_signature");
  const [h, , s] = token.split(".");
  const swapped = `${h}.${part({ sub: "admin" })}.${s}`;
  await rejects(() => verify(swapped, pair.publicKey), "bad_signature");
  await rejects(
    () =>
      verify(
        `${h}.${token.split(".")[1]}.${toBase64Url(new Uint8Array(64))}`,
        pair.publicKey,
      ),
    "bad_signature",
  );
});

/**
 * Runs `fn` with `crypto.subtle[method]` throwing `error`, the way celld
 * 0.5.1's WebCrypto refuses Ed25519 verification and `oct` JWK imports.
 */
async function withFailing(
  method: "verify" | "sign" | "importKey",
  error: Error,
  fn: () => Promise<void>,
): Promise<void> {
  const original = crypto.subtle[method];
  const subtle = crypto.subtle as unknown as Record<string, unknown>;
  const failing = (...args: unknown[]) => {
    // Only JWK imports fail, as in celld; key generation still works.
    if (method === "importKey" && args[0] !== "jwk") {
      return (original as (...a: unknown[]) => unknown).apply(
        crypto.subtle,
        args,
      );
    }
    return Promise.reject(error);
  };
  subtle[method] = failing;
  try {
    await fn();
  } finally {
    subtle[method] = original;
  }
}

const notSupported = () =>
  new DOMException(
    "unsupported verify algorithm: ED25519",
    "NotSupportedError",
  );

Deno.test("a runtime that cannot verify is not a bad signature", async () => {
  const pair = await generateKeyPair("EdDSA");
  const token = await sign({ sub: "a" }, pair.privateKey, { alg: "EdDSA" });
  const refusal = notSupported();
  await withFailing("verify", refusal, async () => {
    const error = await rejects(
      () => verify(token, pair.publicKey),
      "runtime_unsupported",
    );
    assertEquals(error.cause, refusal);
    assert(error.message.includes("EdDSA"), error.message);
    const decoded = decode(token);
    await rejects(
      () =>
        verifyBytes(
          "EdDSA",
          pair.publicKey,
          decoded.signingInput,
          decoded.signature,
        ),
      "runtime_unsupported",
    );
  });
  // Any other WebCrypto failure is a signature that does not verify.
  await withFailing(
    "verify",
    new DOMException("bad signature", "OperationError"),
    async () => {
      await rejects(() => verify(token, pair.publicKey), "bad_signature");
    },
  );
});

Deno.test("a runtime that cannot sign or import is named", async () => {
  const pair = await generateKeyPair("ES256");
  await withFailing("sign", notSupported(), async () => {
    await rejects(
      () => sign({ sub: "a" }, pair.privateKey, { alg: "ES256" }),
      "runtime_unsupported",
    );
  });
  const jwk = { kty: "oct", k: toBase64Url(new Uint8Array(32).fill(7)) };
  await withFailing("importKey", notSupported(), async () => {
    const error = await rejects(
      () => importJwk(jwk, "HS256", "verify"),
      "runtime_unsupported",
    );
    assertEquals((error.cause as Error).name, "NotSupportedError");
  });
  await withFailing(
    "importKey",
    new DOMException("bad key data", "DataError"),
    async () => {
      await rejects(() => importJwk(jwk, "HS256", "verify"), "key_mismatch");
    },
  );
});

async function hs(
  claims: Record<string, unknown>,
  header: Record<string, unknown> = {},
) {
  const secret = new Uint8Array(32).fill(7);
  return {
    secret,
    token: await sign(claims as JwtClaims, secret, { alg: "HS256", header }),
  };
}

Deno.test("expiry and not-before, with tolerance", async () => {
  const { secret, token } = await hs({ exp: secs, nbf: secs - 10 });
  await rejects(() => verify(token, secret, { now }), "expired");
  await verify(token, secret, { now: NOW - 1000 });
  await verify(token, secret, { now, clockTolerance: 1 });
  await rejects(
    () => verify(token, secret, { now: NOW - 11_000 }),
    "not_yet_valid",
  );
  await verify(token, secret, { now: NOW - 11_000, clockTolerance: 1 });
  await verify(token, secret, { now: new Date(NOW - 5000) });
  const bad = await hs({ exp: "soon" });
  await rejects(() => verify(bad.token, bad.secret, { now }), "invalid_claim");
});

Deno.test("maxTokenAge", async () => {
  const { secret, token } = await hs({ iat: secs - 100 });
  await verify(token, secret, { now, maxTokenAge: 100 });
  await rejects(
    () => verify(token, secret, { now, maxTokenAge: 99 }),
    "too_old",
  );
  const future = await hs({ iat: secs + 100 });
  await rejects(
    () => verify(future.token, future.secret, { now, maxTokenAge: 1000 }),
    "not_yet_valid",
  );
  const none = await hs({});
  await rejects(
    () => verify(none.token, none.secret, { now, maxTokenAge: 1 }),
    "missing_claim",
  );
});

Deno.test("issuer, audience and subject", async () => {
  const { secret, token } = await hs({
    iss: "https://issuer",
    aud: ["api", "web"],
    sub: "alice",
  });
  await verify(token, secret, {
    issuer: "https://issuer",
    audience: "web",
    subject: "alice",
  });
  await verify(token, secret, {
    issuer: ["x", "https://issuer"],
    audience: ["cli", "api"],
  });
  await rejects(
    () => verify(token, secret, { issuer: "https://other" }),
    "issuer",
  );
  await rejects(() => verify(token, secret, { audience: "cli" }), "audience");
  await rejects(() => verify(token, secret, { subject: "bob" }), "subject");
  const single = await hs({ aud: "api" });
  await verify(single.token, single.secret, { audience: "api" });
  const bare = await hs({});
  await rejects(
    () => verify(bare.token, bare.secret, { issuer: "x" }),
    "missing_claim",
  );
  await rejects(
    () => verify(bare.token, bare.secret, { audience: "x" }),
    "missing_claim",
  );
  const numeric = await hs({ aud: [1] });
  await rejects(() => verify(numeric.token, numeric.secret), "invalid_claim");
  const iss = await hs({ iss: 1 });
  await rejects(() => verify(iss.token, iss.secret), "invalid_claim");
});

Deno.test("required claims", async () => {
  const { secret, token } = await hs({ jti: "1" });
  await verify(token, secret, { requiredClaims: ["jti"] });
  await rejects(
    () => verify(token, secret, { requiredClaims: ["exp"] }),
    "missing_claim",
  );
});

Deno.test("typ and crit", async () => {
  const { secret, token } = await hs({}, {
    typ: "application/at+JWT",
    crit: ["exp2"],
    exp2: 1,
  });
  await rejects(() => verify(token, secret), "crit");
  await verify(token, secret, { crit: ["exp2"], typ: "at+jwt" });
  await rejects(
    () => verify(token, secret, { crit: ["exp2"], typ: ["JWT"] }),
    "typ",
  );
  const untyped = await sign({}, secret, { alg: "HS256", typ: null });
  await rejects(() => verify(untyped, secret, { typ: "JWT" }), "typ");
});

Deno.test("key sets", async () => {
  const a = await generateKeyPair("ES256", { kid: "a" });
  const b = await generateKeyPair("RS256", { kid: "b" });
  const set = localJwks({ keys: [a.publicJwk, b.publicJwk] });
  const tokenA = await sign({}, a.privateKey, { alg: "ES256", kid: "a" });
  const tokenB = await sign({}, b.privateKey, { alg: "RS256", kid: "b" });
  await verify(tokenA, set);
  await verify(tokenB, set);
  await verify(tokenB, { keys: [a.publicJwk, b.publicJwk] });
  const untagged = await sign({}, a.privateKey, { alg: "ES256" });
  await verify(untagged, set);
  const two = await generateKeyPair("ES256", { kid: "c" });
  await rejects(
    () => verify(untagged, { keys: [a.publicJwk, two.publicJwk] }),
    "no_key",
  );
  const wrongKid = await sign({}, a.privateKey, { alg: "ES256", kid: "b" });
  await rejects(() => verify(wrongKid, set), "no_key");
});

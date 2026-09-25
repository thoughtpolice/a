// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

import { assert, assertEquals } from "@celld/assert";
import {
  checkKey,
  exportPublicJwk,
  generateKeyPair,
  generateSecret,
  importJwk,
  importKey,
  isJwsAlgorithm,
  type Jwk,
  jwkFits,
  jwkThumbprint,
  JWS_ALGORITHMS,
  publicJwk,
  signBytes,
  verifyBytes,
} from "@celld/jwt";
import { rejects } from "./fixture.ts";

const data = new TextEncoder().encode("payload");

Deno.test("algorithm names", () => {
  assertEquals(JWS_ALGORITHMS.length, 14);
  assert(isJwsAlgorithm("ES256") && isJwsAlgorithm("Ed25519"), "known");
  for (const name of ["none", "HS1", "es256", "toString", "", 5]) {
    assert(!isJwsAlgorithm(name), String(name));
  }
});

Deno.test("jwkFits", () => {
  assert(
    jwkFits({ kty: "RSA" }, "RS256") && jwkFits({ kty: "RSA" }, "PS512"),
    "rsa",
  );
  assert(!jwkFits({ kty: "RSA" }, "ES256"), "rsa for ec");
  assert(jwkFits({ kty: "EC", crv: "P-384" }, "ES384"), "ec");
  assert(!jwkFits({ kty: "EC", crv: "P-256" }, "ES384"), "curve");
  assert(jwkFits({ kty: "OKP", crv: "Ed25519" }, "EdDSA"), "okp");
  assert(
    jwkFits({ kty: "OKP", crv: "Ed25519", alg: "EdDSA" }, "Ed25519"),
    "EdDSA names",
  );
  assert(!jwkFits({ kty: "OKP", crv: "Ed448" }, "EdDSA"), "ed448");
  assert(jwkFits({ kty: "oct" }, "HS256"), "oct");
  assert(!jwkFits({ kty: "oct" }, "RS256"), "oct for rsa");
  assert(!jwkFits({ kty: "RSA", alg: "RS384" }, "RS256"), "alg member");
  assert(!jwkFits({ kty: "RSA", use: "enc" }, "RS256"), "use member");
  assert(jwkFits({ kty: "RSA", use: "sig", alg: "RS256" }, "RS256"), "members");
});

Deno.test("every asymmetric algorithm signs and verifies", async () => {
  for (const alg of JWS_ALGORITHMS.filter((alg) => !alg.startsWith("HS"))) {
    const pair = await generateKeyPair(alg, { kid: alg });
    assertEquals(pair.publicJwk.alg, alg);
    assertEquals(pair.publicJwk.kid, alg);
    assertEquals(pair.publicJwk.d, undefined);
    const signature = await signBytes(alg, pair.privateKey, data);
    assert(await verifyBytes(alg, pair.publicKey, data, signature), alg);
    assert(
      await verifyBytes(alg, pair.publicJwk, data, signature),
      `${alg} jwk`,
    );
    const tampered = Uint8Array.from(signature);
    tampered[tampered.length - 1] ^= 1;
    assert(
      !(await verifyBytes(alg, pair.publicKey, data, tampered)),
      `${alg} tampered`,
    );
    assert(
      !(await verifyBytes(alg, pair.publicKey, data, signature.subarray(1))),
      `${alg} short`,
    );
  }
});

Deno.test("ECDSA signatures are raw r || s", async () => {
  const lengths = { ES256: 64, ES384: 96, ES512: 132 } as const;
  for (const [alg, length] of Object.entries(lengths)) {
    const pair = await generateKeyPair(alg as keyof typeof lengths);
    const signature = await signBytes(
      alg as keyof typeof lengths,
      pair.privateKey,
      data,
    );
    assertEquals(signature.length, length, alg);
  }
});

Deno.test("HMAC secrets", async () => {
  for (const alg of ["HS256", "HS384", "HS512"] as const) {
    const secret = generateSecret(alg);
    assertEquals(secret.length * 8, Number(alg.slice(2)));
    const signature = await signBytes(alg, secret, data);
    assert(await verifyBytes(alg, secret, data, signature), alg);
    const jwk: Jwk = {
      kty: "oct",
      k: btoa(String.fromCharCode(...secret)).replaceAll("+", "-").replaceAll(
        "/",
        "_",
      ).replace(/=+$/, ""),
    };
    assert(await verifyBytes(alg, jwk, data, signature), `${alg} jwk`);
    await rejects(
      () => signBytes(alg, secret.subarray(1), data),
      "key_mismatch",
    );
  }
  await rejects(() => generateSecret("RS256"), "key_mismatch");
  await rejects(() => generateKeyPair("HS256"), "key_mismatch");
});

Deno.test("keys must fit their algorithm", async () => {
  const rsa = await generateKeyPair("RS256");
  const ec = await generateKeyPair("ES256");
  const ed = await generateKeyPair("EdDSA");
  await rejects(
    () => verifyBytes("RS384", rsa.publicKey, data, data),
    "key_mismatch",
  );
  await rejects(
    () => verifyBytes("PS256", rsa.publicKey, data, data),
    "key_mismatch",
  );
  await rejects(
    () => verifyBytes("ES384", ec.publicKey, data, data),
    "key_mismatch",
  );
  await rejects(
    () => verifyBytes("RS256", ed.publicKey, data, data),
    "key_mismatch",
  );
  await rejects(
    () => verifyBytes("RS256", rsa.privateKey, data, data),
    "key_mismatch",
  );
  await rejects(() => signBytes("RS256", rsa.publicKey, data), "key_mismatch");
  await rejects(() => signBytes("RS256", rsa.publicJwk, data), "key_mismatch");
  await rejects(
    () => verifyBytes("RS256", new Uint8Array(64), data, data),
    "key_mismatch",
  );
  await rejects(
    () => verifyBytes("HS256", rsa.publicJwk, data, data),
    "key_mismatch",
  );
  await rejects(
    () => verifyBytes("ES256", { ...ec.publicJwk, alg: "ES384" }, data, data),
    "key_mismatch",
  );
  await rejects(
    () => importJwk({ kty: "RSA", e: "AQAB" }, "RS256", "verify"),
    "key_mismatch",
  );
  checkKey(rsa.publicKey, "RS256", "verify");
});

Deno.test("RSA keys under 2048 bits are refused", async () => {
  const small = await generateKeyPair("RS256", { modulusLength: 1024 });
  await rejects(
    () => signBytes("RS256", small.privateKey, data),
    "key_mismatch",
  );
  await rejects(
    () => verifyBytes("RS256", small.publicJwk, data, data),
    "key_mismatch",
  );
});

Deno.test("private JWKs verify, public ones only verify", async () => {
  const pair = await generateKeyPair("ES256", { extractable: true });
  const privateJwk = await crypto.subtle.exportKey(
    "jwk",
    pair.privateKey,
  ) as Jwk;
  const signature = await signBytes("ES256", privateJwk, data);
  assert(
    await verifyBytes("ES256", privateJwk, data, signature),
    "private jwk verifies",
  );
  assertEquals(publicJwk(privateJwk).d, undefined);
  assertEquals((await exportPublicJwk(pair.privateKey)).d, undefined);
  const key = await importKey(pair.publicJwk, "ES256", "verify");
  assertEquals(key.type, "public");
});

Deno.test("RFC 7638 thumbprints", async () => {
  // RFC 8037 appendix A.3: the thumbprint of its Ed25519 example key.
  assertEquals(
    await jwkThumbprint({
      kty: "OKP",
      crv: "Ed25519",
      x: "11qYAYKxCrfVS_7TyWQHOg7hcvPapiMlrwIaaPcHURo",
    }),
    "kPrK_qmxVWaYVA9wwBF6Iuo3vVzz7TxHCTwXBygrS4k",
  );
  const pair = await generateKeyPair("ES256");
  const withExtras = { ...pair.publicJwk, kid: "x", use: "sig" };
  assertEquals(
    await jwkThumbprint(withExtras),
    await jwkThumbprint(pair.publicJwk),
  );
  await rejects(
    () => jwkThumbprint({ kty: "EC", crv: "P-256", x: "a" }),
    "key_mismatch",
  );
  await rejects(() => jwkThumbprint({ kty: "XYZ" }), "key_mismatch");
});

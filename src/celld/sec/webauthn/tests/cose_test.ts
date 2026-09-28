// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

import { assert, assertEquals, assertThrows } from "@celld/core/assert";
import { toBase64Url as toB64 } from "@celld/sec/jwt";
import {
  derToP1363,
  importCoseKey,
  onCurve,
  parseCoseKey,
  verifySignature,
  WebAuthnError,
} from "@celld/sec/webauthn";
import { p1363ToDer } from "@celld/sec/webauthn/testing";

function hex(text: string): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(text.match(/../g) ?? [], (b) => parseInt(b, 16));
}

function coded(fn: () => unknown, code: string) {
  const error = assertThrows(fn, WebAuthnError);
  assertEquals(error.code, code, error.message);
}

const X = new Uint8Array(32).fill(1);
const Y = new Uint8Array(32).fill(2);
// The P-256 generator: a point on the curve.
const GX = hex(
  "6b17d1f2e12c4247f8bce6e563a440f277037d812deb33a0f4a13945d898c296",
);
const GY = hex(
  "4fe342e2fe1a7f9b8ee7eb4a7c0f9e162bce33576b315ececbb6406837bf51f5",
);

Deno.test("cose: keys must match their algorithm", () => {
  const es256 = (extra: [number, unknown][] = []) =>
    new Map<number, unknown>([
      [1, 2],
      [3, -7],
      [-1, 1],
      [-2, GX],
      [-3, GY],
      ...extra,
    ]);
  assertEquals(parseCoseKey(es256() as never).alg, -7);
  coded(() => parseCoseKey(es256([[-1, 2]]) as never), "invalid_response");
  coded(() => parseCoseKey(es256([[1, 1]]) as never), "invalid_response");
  coded(() => parseCoseKey(es256([[-3, true]]) as never), "invalid_response");
  coded(
    () => parseCoseKey(es256([[-2, GX.subarray(1)]]) as never),
    "invalid_response",
  );
  coded(
    () => parseCoseKey(es256([[3, -53]]) as never),
    "unsupported_algorithm",
  );
  coded(
    () => parseCoseKey(es256([[3, -999]]) as never),
    "unsupported_algorithm",
  );
  coded(
    () =>
      parseCoseKey(
        new Map<number, unknown>([[3, -8], [1, 1], [-1, 7], [-2, X]]) as never,
      ),
    "invalid_response",
  );
  coded(() => parseCoseKey("not a map" as never), "invalid_response");
  // Other labels (a kid) are ignored.
  assertEquals(
    parseCoseKey(es256([[2, new Uint8Array([1])]]) as never).alg,
    -7,
  );
});

Deno.test("cose: RSA moduli are at least 2048 bits and minimal", () => {
  const rsa = (n: Uint8Array, e = new Uint8Array([1, 0, 1])) =>
    new Map<number, unknown>([[1, 3], [3, -257], [-1, n], [-2, e]]);
  const n = new Uint8Array(256).fill(0xc3);
  assertEquals(parseCoseKey(rsa(n) as never).alg, -257);
  coded(() => parseCoseKey(rsa(n.subarray(1)) as never), "invalid_response");
  coded(
    () => parseCoseKey(rsa(Uint8Array.of(0, ...n)) as never),
    "invalid_response",
  );
  coded(
    () => parseCoseKey(rsa(n, new Uint8Array([0, 1])) as never),
    "invalid_response",
  );
});

Deno.test("cose: DER signatures convert exactly, and loose DER is refused", () => {
  const r = "7f".padEnd(64, "1");
  const s = "01".padEnd(64, "2");
  assertEquals([...derToP1363(hex(`30440220${r}0220${s}`), 32)!], [
    ...hex(r + s),
  ]);
  // A high bit takes a zero byte; a short integer is padded back.
  const high = "80".padEnd(64, "3");
  const padded = derToP1363(hex(`3026022100${high}020101`), 32)!;
  assertEquals([...padded.subarray(0, 32)], [...hex(high)]);
  assertEquals([...padded.subarray(32)], [...new Uint8Array(31), 1]);
  const refused = [
    "31", // not a SEQUENCE
    `30450220${r}0220${s}`, // the length is wrong
    `3044022000${r.slice(2)}0220${s}`, // a needless leading zero
    `30440220${"80".padEnd(64, "0")}0220${s}`, // a negative r
    `3045022100${"7f".padEnd(64, "0")}0220${s}`, // a zero before a low bit
    `30440220${r}0220${s}00`, // a trailing byte
    `3046022200${high}0220${s}`, // an integer over 33 bytes
    "3080", // indefinite length
  ];
  for (const der of refused) assertEquals(derToP1363(hex(der), 32), null, der);
});

Deno.test("cose: P1363 to DER and back, for random signatures", () => {
  for (let i = 0; i < 200; i++) {
    const raw = crypto.getRandomValues(new Uint8Array(64));
    if (i % 3 === 0) raw.fill(0, 0, 1 + (i % 5));
    if (i % 4 === 0) raw.fill(0, 32, 33 + (i % 3));
    const back = derToP1363(p1363ToDer(raw), 32);
    assert(back !== null, `round trip ${i}`);
    assertEquals([...back], [...raw]);
  }
});

Deno.test("cose: an EC point off its curve is refused, whatever import would do", async () => {
  // Deno's WebCrypto imports this JWK without complaint.
  await crypto.subtle.importKey(
    "jwk",
    { kty: "EC", crv: "P-256", x: toB64(X), y: toB64(Y) },
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["verify"],
  );
  coded(
    () =>
      parseCoseKey(
        new Map<number, unknown>([[1, 2], [3, -7], [-1, 1], [-2, X], [
          -3,
          Y,
        ]]) as never,
      ),
    "invalid_response",
  );
  // The P-256 generator is on it; one off in y is not; p itself is out of range.
  assert(onCurve("P-256", GX, GY), "the generator");
  const off = Uint8Array.from(GY);
  off[31] ^= 1;
  assert(!onCurve("P-256", GX, off), "off by one bit");
  assert(!onCurve("P-256", new Uint8Array(32).fill(0xff), GY), "x past p");
});

Deno.test("cose: signatures verify for each key type", async () => {
  const data = new TextEncoder().encode("signed data");
  for (
    const [alg, params, curveBytes] of [
      [-7, { name: "ECDSA", namedCurve: "P-256" }, 32],
      [-8, { name: "Ed25519" }, 0],
    ] as const
  ) {
    const pair = await crypto.subtle.generateKey(
      params as EcKeyGenParams,
      true,
      ["sign", "verify"],
    ) as CryptoKeyPair;
    let cose: Map<number, unknown>;
    let signature: Uint8Array;
    if (alg === -7) {
      const jwk = await crypto.subtle.exportKey("jwk", pair.publicKey);
      const b = (t: string) =>
        Uint8Array.from(
          atob(t.replace(/-/g, "+").replace(/_/g, "/")),
          (c) => c.charCodeAt(0),
        );
      cose = new Map<number, unknown>([[1, 2], [3, -7], [-1, 1], [
        -2,
        b(jwk.x!),
      ], [-3, b(jwk.y!)]]);
      signature = p1363ToDer(
        new Uint8Array(
          await crypto.subtle.sign(
            { name: "ECDSA", hash: "SHA-256" },
            pair.privateKey,
            data,
          ),
        ),
      );
      assertEquals(curveBytes, 32);
    } else {
      const raw = new Uint8Array(
        await crypto.subtle.exportKey("raw", pair.publicKey),
      );
      cose = new Map<number, unknown>([[1, 1], [3, -8], [-1, 6], [-2, raw]]);
      signature = new Uint8Array(
        await crypto.subtle.sign({ name: "Ed25519" }, pair.privateKey, data),
      );
    }
    const key = parseCoseKey(cose as never);
    const imported = await importCoseKey(key);
    assert(
      await verifySignature(key.alg, imported, signature, data),
      `${alg} verifies`,
    );
    const tampered = Uint8Array.from(data);
    tampered[0] ^= 1;
    assert(
      !await verifySignature(key.alg, imported, signature, tampered),
      `${alg} tamper`,
    );
    assert(
      !await verifySignature(key.alg, imported, signature.subarray(1), data),
      `${alg} truncated`,
    );
  }
});

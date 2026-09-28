// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * Credential public keys: COSE keys (RFC 9052, 9053, 8230) as
 * authenticators write them, checked against their algorithm, imported
 * into WebCrypto, and used to verify WebAuthn signatures, whose ECDSA form
 * is ASN.1 DER rather than COSE's `r || s`.
 *
 * | alg | name | key | signature |
 * | --- | --- | --- | --- |
 * | -8, -19 | EdDSA, Ed25519 | OKP, Ed25519 | raw, 64 bytes |
 * | -7, -9 | ES256, ESP256 | EC2, P-256 | DER |
 * | -35, -51 | ES384, ESP384 | EC2, P-384 | DER |
 * | -36, -52 | ES512, ESP512 | EC2, P-521 | DER |
 * | -257 | RS256 | RSA, at least 2048 bits | PKCS #1 v1.5 |
 * | -37 | PS256 | RSA, at least 2048 bits | PSS, 32-byte salt |
 *
 * Ed448 (-53) is not in WebCrypto, so it is not supported.
 *
 * @module
 */

import { toBase64Url } from "@celld/sec/jwt";
import type { CborMap, CborValue } from "./cbor.ts";
import { WebAuthnError } from "./errors.ts";

/** A COSE algorithm this library verifies. */
export type CoseAlgorithm =
  | -7
  | -8
  | -9
  | -19
  | -35
  | -36
  | -37
  | -51
  | -52
  | -257;

/**
 * The algorithms the spec asks relying parties to offer, most preferred
 * first: EdDSA, ES256, RS256 (§5.4). Its fully specified twins (-9, -19)
 * are NOT RECOMMENDED there, since many authenticators know only these.
 */
export const DEFAULT_ALGORITHMS: readonly CoseAlgorithm[] = Object.freeze([
  -8,
  -7,
  -257,
]);

interface Ec {
  readonly kty: "EC2";
  readonly curve: "P-256" | "P-384" | "P-521";
  readonly size: number;
  readonly hash: "SHA-256" | "SHA-384" | "SHA-512";
  readonly crv: number;
}
interface Okp {
  readonly kty: "OKP";
}
interface Rsa {
  readonly kty: "RSA";
  readonly pss: boolean;
}

const ALGORITHMS: ReadonlyMap<number, Ec | Okp | Rsa> = new Map<
  number,
  Ec | Okp | Rsa
>([
  [-7, { kty: "EC2", curve: "P-256", size: 32, hash: "SHA-256", crv: 1 }],
  [-9, { kty: "EC2", curve: "P-256", size: 32, hash: "SHA-256", crv: 1 }],
  [-35, { kty: "EC2", curve: "P-384", size: 48, hash: "SHA-384", crv: 2 }],
  [-51, { kty: "EC2", curve: "P-384", size: 48, hash: "SHA-384", crv: 2 }],
  [-36, { kty: "EC2", curve: "P-521", size: 66, hash: "SHA-512", crv: 3 }],
  [-52, { kty: "EC2", curve: "P-521", size: 66, hash: "SHA-512", crv: 3 }],
  [-8, { kty: "OKP" }],
  [-19, { kty: "OKP" }],
  [-257, { kty: "RSA", pss: false }],
  [-37, { kty: "RSA", pss: true }],
]);

const KTY: Readonly<Record<string, number>> = { OKP: 1, EC2: 2, RSA: 3 };

/** Whether `alg` is one this library verifies. */
export function isSupportedAlgorithm(alg: unknown): alg is CoseAlgorithm {
  return typeof alg === "number" && ALGORITHMS.has(alg);
}

/** A checked credential public key. */
export interface CoseKey {
  readonly alg: CoseAlgorithm;
  /** The JWK WebCrypto imports (EC and RSA), or the raw Ed25519 key. */
  readonly jwk?: JsonWebKey;
  readonly raw?: Uint8Array<ArrayBuffer>;
}

function invalid(message: string): WebAuthnError {
  return new WebAuthnError("invalid_response", message);
}

function bytesAt(map: CborMap, label: number, what: string): Uint8Array {
  const value = map.get(label);
  if (!(value instanceof Uint8Array)) {
    throw invalid(`the credential public key's ${what} is not a byte string`);
  }
  return value;
}

/** The prime and the `b` of each NIST curve (y² = x³ - 3x + b mod p). */
const CURVES: Readonly<Record<Ec["curve"], { p: bigint; b: bigint }>> = {
  "P-256": {
    p: 2n ** 256n - 2n ** 224n + 2n ** 192n + 2n ** 96n - 1n,
    b: 0x5ac635d8aa3a93e7b3ebbd55769886bc651d06b0cc53b0f63bce3c3e27d2604bn,
  },
  "P-384": {
    p: 2n ** 384n - 2n ** 128n - 2n ** 96n + 2n ** 32n - 1n,
    b: 0xb3312fa7e23ee7e4988e056be3f82d19181d9c6efe8141120314088f5013875ac656398d8a2ed19d2a85c8edd3ec2aefn,
  },
  "P-521": {
    p: 2n ** 521n - 1n,
    b: 0x0051953eb9618e1c9a1f929a21a0b68540eea2da725b99b315f3b8b489918ef109e156193951ec7e937b1652c0bd3bb1bf073573df883d2c34f1ef451fd46b503f00n,
  },
};

function toBigInt(bytes: Uint8Array): bigint {
  let value = 0n;
  for (const byte of bytes) value = value << 8n | BigInt(byte);
  return value;
}

/**
 * Whether `(x, y)` is a point on `curve`. WebCrypto's JWK import is meant
 * to check this, but not every runtime does (Deno 2.9 does not), and the
 * spec asks relying parties to (§5.8.5).
 */
export function onCurve(
  curve: "P-256" | "P-384" | "P-521",
  x: Uint8Array,
  y: Uint8Array,
): boolean {
  const { p, b } = CURVES[curve];
  const px = toBigInt(x);
  const py = toBigInt(y);
  if (px >= p || py >= p) return false;
  const mod = (value: bigint) => ((value % p) + p) % p;
  return mod(py * py) === mod(px * px * px - 3n * px + b);
}

function minimal(bytes: Uint8Array, what: string): void {
  if (bytes.length === 0 || bytes[0] === 0) {
    throw invalid(`the credential public key's ${what} is not minimal`);
  }
}

/**
 * Checks a decoded COSE key: a supported `alg`, the `kty` and curve that
 * algorithm requires, and parameters of the right size (uncompressed EC
 * points, an RSA modulus of at least 2048 bits). Other labels are ignored.
 */
export function parseCoseKey(value: CborValue): CoseKey {
  if (!(value instanceof Map)) {
    throw invalid("the credential public key is not a CBOR map");
  }
  const map = value as CborMap;
  const alg = map.get(3);
  if (!isSupportedAlgorithm(alg)) {
    throw new WebAuthnError(
      "unsupported_algorithm",
      `the credential's algorithm ${String(alg)} is not supported`,
    );
  }
  const spec = ALGORITHMS.get(alg)!;
  if (map.get(1) !== KTY[spec.kty]) {
    throw invalid(`algorithm ${alg} needs a ${spec.kty} key`);
  }
  if (spec.kty === "EC2") {
    if (map.get(-1) !== spec.crv) {
      throw invalid(`algorithm ${alg} needs the curve ${spec.curve}`);
    }
    const x = bytesAt(map, -2, "x");
    const y = bytesAt(map, -3, "y");
    if (x.length !== spec.size || y.length !== spec.size) {
      throw invalid(`a ${spec.curve} point has ${spec.size}-byte coordinates`);
    }
    if (!onCurve(spec.curve, x, y)) {
      throw invalid(
        `the credential public key is not a point on ${spec.curve}`,
      );
    }
    return Object.freeze({
      alg,
      jwk: Object.freeze({
        kty: "EC",
        crv: spec.curve,
        x: toBase64Url(x),
        y: toBase64Url(y),
      }),
    });
  }
  if (spec.kty === "OKP") {
    if (map.get(-1) !== 6) throw invalid(`algorithm ${alg} needs Ed25519`);
    const x = bytesAt(map, -2, "x");
    if (x.length !== 32) throw invalid("an Ed25519 key is 32 bytes");
    return Object.freeze({ alg, raw: Uint8Array.from(x) });
  }
  const n = bytesAt(map, -1, "modulus");
  const e = bytesAt(map, -2, "exponent");
  minimal(n, "modulus");
  minimal(e, "exponent");
  if (n.length < 256 || n.length > 2048) {
    throw invalid("an RSA modulus must be 2048 to 16384 bits");
  }
  if (e.length > 8) throw invalid("the RSA exponent is too large");
  return Object.freeze({
    alg,
    jwk: Object.freeze({ kty: "RSA", n: toBase64Url(n), e: toBase64Url(e) }),
  });
}

function importParams(
  alg: CoseAlgorithm,
): EcKeyImportParams | RsaHashedImportParams | Algorithm {
  const spec = ALGORITHMS.get(alg)!;
  if (spec.kty === "EC2") return { name: "ECDSA", namedCurve: spec.curve };
  if (spec.kty === "OKP") return { name: "Ed25519" };
  return {
    name: spec.pss ? "RSA-PSS" : "RSASSA-PKCS1-v1_5",
    hash: "SHA-256",
  };
}

/**
 * Imports a checked key for verifying. EC keys go through JWK, whose
 * import checks the point is on the curve (raw import need not).
 */
export async function importCoseKey(key: CoseKey): Promise<CryptoKey> {
  try {
    if (key.raw !== undefined) {
      return await crypto.subtle.importKey(
        "raw",
        key.raw,
        importParams(key.alg),
        false,
        ["verify"],
      );
    }
    return await crypto.subtle.importKey(
      "jwk",
      key.jwk!,
      importParams(key.alg),
      false,
      ["verify"],
    );
  } catch (cause) {
    throw new WebAuthnError(
      "invalid_response",
      "the credential public key does not import",
      { cause },
    );
  }
}

/**
 * An ASN.1 DER ECDSA signature (`SEQUENCE { r INTEGER, s INTEGER }`) as
 * IEEE P1363 `r || s`, each `size` bytes, or null when it is not strict
 * DER: long-form lengths only where needed, positive minimal integers,
 * nothing left over.
 */
export function derToP1363(
  der: Uint8Array,
  size: number,
): Uint8Array<ArrayBuffer> | null {
  let offset = 0;
  const length = (): number | null => {
    if (offset >= der.length) return null;
    const first = der[offset++];
    if (first < 0x80) return first;
    if (first !== 0x81 || offset >= der.length) return null;
    const long = der[offset++];
    return long < 0x80 ? null : long;
  };
  if (der[offset++] !== 0x30) return null;
  const total = length();
  if (total === null || total !== der.length - offset) return null;
  const out = new Uint8Array(size * 2);
  for (let part = 0; part < 2; part++) {
    if (der[offset++] !== 0x02) return null;
    const len = length();
    if (
      len === null || len < 1 || len > size + 1 || offset + len > der.length
    ) {
      return null;
    }
    const value = der.subarray(offset, offset + len);
    offset += len;
    if (value[0] >= 0x80) return null;
    if (value[0] === 0 && (len === 1 || value[1] < 0x80)) return null;
    const trimmed = value[0] === 0 ? value.subarray(1) : value;
    if (trimmed.length > size) return null;
    out.set(trimmed, part * size + size - trimmed.length);
  }
  return offset === der.length ? out : null;
}

/**
 * Whether `signature` is `key`'s over `data`, in WebAuthn's encoding for
 * `alg`. A malformed ECDSA signature is simply not valid.
 */
export async function verifySignature(
  alg: CoseAlgorithm,
  key: CryptoKey,
  signature: Uint8Array,
  data: Uint8Array,
): Promise<boolean> {
  const spec = ALGORITHMS.get(alg)!;
  const bytes = Uint8Array.from(data);
  if (spec.kty === "EC2") {
    const raw = derToP1363(signature, spec.size);
    if (raw === null) return false;
    return await crypto.subtle.verify(
      { name: "ECDSA", hash: spec.hash },
      key,
      raw,
      bytes,
    );
  }
  const sig = Uint8Array.from(signature);
  if (spec.kty === "OKP") {
    if (sig.length !== 64) return false;
    return await crypto.subtle.verify({ name: "Ed25519" }, key, sig, bytes);
  }
  return await crypto.subtle.verify(
    spec.pss
      ? { name: "RSA-PSS", saltLength: 32 } as RsaPssParams
      : { name: "RSASSA-PKCS1-v1_5" },
    key,
    sig,
    bytes,
  );
}

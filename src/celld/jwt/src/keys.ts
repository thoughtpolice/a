// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * The JWS algorithms (RFC 7518, RFC 8037, RFC 9864) on WebCrypto, and
 * keys for them: importing JWKs and secrets, checking that a key fits an
 * algorithm, generating keys, exporting public JWKs and RFC 7638
 * thumbprints, and the raw sign and verify steps.
 *
 * @module
 */

import { toBase64Url } from "./base64url.ts";
import { isRuntimeUnsupported, JwtError } from "./errors.ts";

/** Every signature algorithm implemented; `none` is not one of them. */
export const JWS_ALGORITHMS = [
  "HS256",
  "HS384",
  "HS512",
  "RS256",
  "RS384",
  "RS512",
  "PS256",
  "PS384",
  "PS512",
  "ES256",
  "ES384",
  "ES512",
  "EdDSA",
  "Ed25519",
] as const;

/** A signature algorithm. `EdDSA` and `Ed25519` both mean Ed25519 here. */
export type JwsAlgorithm = typeof JWS_ALGORITHMS[number];

/** A public or private JWK, with the members a JWKS entry may carry. */
export type Jwk = JsonWebKey & {
  kid?: string;
  alg?: string;
  use?: string;
  x5c?: string[];
  x5t?: string;
  "x5t#S256"?: string;
};

/** A JWK Set (RFC 7517 section 5). */
export interface Jwks {
  readonly keys: readonly Jwk[];
}

/**
 * A key for {@link sign} or {@link verify}: a `CryptoKey`, a JWK, or the
 * raw bytes of an HMAC secret.
 */
export type KeyLike = CryptoKey | Jwk | Uint8Array;

type Family = "HMAC" | "RSA" | "PSS" | "EC" | "OKP";
type Hash = "SHA-256" | "SHA-384" | "SHA-512";

interface Spec {
  readonly family: Family;
  readonly hash: Hash;
  readonly curve?: "P-256" | "P-384" | "P-521";
}

const SPECS: Readonly<Record<JwsAlgorithm, Spec>> = {
  HS256: { family: "HMAC", hash: "SHA-256" },
  HS384: { family: "HMAC", hash: "SHA-384" },
  HS512: { family: "HMAC", hash: "SHA-512" },
  RS256: { family: "RSA", hash: "SHA-256" },
  RS384: { family: "RSA", hash: "SHA-384" },
  RS512: { family: "RSA", hash: "SHA-512" },
  PS256: { family: "PSS", hash: "SHA-256" },
  PS384: { family: "PSS", hash: "SHA-384" },
  PS512: { family: "PSS", hash: "SHA-512" },
  ES256: { family: "EC", hash: "SHA-256", curve: "P-256" },
  ES384: { family: "EC", hash: "SHA-384", curve: "P-384" },
  ES512: { family: "EC", hash: "SHA-512", curve: "P-521" },
  EdDSA: { family: "OKP", hash: "SHA-512" },
  Ed25519: { family: "OKP", hash: "SHA-512" },
};

const WEBCRYPTO_NAMES: Readonly<Record<Family, string>> = {
  HMAC: "HMAC",
  RSA: "RSASSA-PKCS1-v1_5",
  PSS: "RSA-PSS",
  EC: "ECDSA",
  OKP: "Ed25519",
};

const HASH_BITS: Readonly<Record<Hash, number>> = {
  "SHA-256": 256,
  "SHA-384": 384,
  "SHA-512": 512,
};

/** RFC 7518 section 3.3: RSA keys of 2048 bits or more. */
export const MIN_RSA_BITS = 2048;

/** Whether `alg` is one this library implements. */
export function isJwsAlgorithm(alg: unknown): alg is JwsAlgorithm {
  return typeof alg === "string" && Object.hasOwn(SPECS, alg);
}

function importParams(alg: JwsAlgorithm): Algorithm {
  const spec = SPECS[alg];
  const name = WEBCRYPTO_NAMES[spec.family];
  switch (spec.family) {
    case "HMAC":
    case "RSA":
    case "PSS":
      return { name, hash: spec.hash } as RsaHashedImportParams;
    case "EC":
      return { name, namedCurve: spec.curve } as EcKeyImportParams;
    case "OKP":
      return { name };
  }
}

function signParams(alg: JwsAlgorithm): Algorithm {
  const spec = SPECS[alg];
  const name = WEBCRYPTO_NAMES[spec.family];
  switch (spec.family) {
    case "PSS":
      return { name, saltLength: HASH_BITS[spec.hash] / 8 } as RsaPssParams;
    case "EC":
      return { name, hash: spec.hash } as EcdsaParams;
    default:
      return { name };
  }
}

/** The key type (`kty`) and curve a JWK for `alg` has. */
function jwkShape(alg: JwsAlgorithm): { kty: string; crv?: string } {
  const spec = SPECS[alg];
  switch (spec.family) {
    case "HMAC":
      return { kty: "oct" };
    case "RSA":
    case "PSS":
      return { kty: "RSA" };
    case "EC":
      return { kty: "EC", crv: spec.curve };
    case "OKP":
      return { kty: "OKP", crv: "Ed25519" };
  }
}

/**
 * Whether a JWK can be used with `alg`: its `kty` and `crv` match, and
 * its `alg` and `use`, when present, are `alg` and `sig`.
 */
export function jwkFits(jwk: Jwk, alg: JwsAlgorithm): boolean {
  if (jwk.alg !== undefined && jwk.alg !== alg) {
    const eddsa = (a: string) => a === "EdDSA" || a === "Ed25519";
    if (!(eddsa(jwk.alg) && eddsa(alg))) return false;
  }
  if (jwk.use !== undefined && jwk.use !== "sig") return false;
  const shape = jwkShape(alg);
  return jwk.kty === shape.kty &&
    (shape.crv === undefined || jwk.crv === shape.crv);
}

type Usage = "sign" | "verify";

/**
 * Throws `key_mismatch` unless `key` is a WebCrypto key for `alg` (right
 * algorithm, hash, curve and size) that allows `usage`.
 */
export function checkKey(
  key: CryptoKey,
  alg: JwsAlgorithm,
  usage: Usage,
): void {
  const spec = SPECS[alg];
  const algorithm = key.algorithm as
    & KeyAlgorithm
    & Partial<
      {
        hash: KeyAlgorithm;
        namedCurve: string;
        length: number;
        modulusLength: number;
      }
    >;
  const fail = (why: string) => {
    throw new JwtError("key_mismatch", `key does not fit ${alg}: ${why}`);
  };
  if (algorithm.name !== WEBCRYPTO_NAMES[spec.family]) {
    fail(`it is an ${algorithm.name} key`);
  }
  if (
    spec.family === "HMAC" || spec.family === "RSA" || spec.family === "PSS"
  ) {
    if (algorithm.hash?.name !== spec.hash) {
      fail(`it is bound to ${algorithm.hash?.name}`);
    }
  }
  if (
    spec.family === "HMAC" && (algorithm.length ?? 0) < HASH_BITS[spec.hash]
  ) {
    fail(`an HMAC key needs at least ${HASH_BITS[spec.hash]} bits`);
  }
  if (
    (spec.family === "RSA" || spec.family === "PSS") &&
    (algorithm.modulusLength ?? 0) < MIN_RSA_BITS
  ) {
    fail(`an RSA key needs at least ${MIN_RSA_BITS} bits`);
  }
  if (spec.family === "EC" && algorithm.namedCurve !== spec.curve) {
    fail(`it is on ${algorithm.namedCurve}`);
  }
  const types = usage === "sign" ? ["private", "secret"] : ["public", "secret"];
  if (!types.includes(key.type)) fail(`a ${key.type} key cannot ${usage}`);
  if (!key.usages.includes(usage)) fail(`its usages do not include ${usage}`);
}

const PRIVATE_MEMBERS = ["d", "p", "q", "dp", "dq", "qi", "oth"] as const;

/** A JWK without its private members; an `oct` key is returned as it is. */
export function publicJwk(jwk: Jwk): Jwk {
  if (jwk.kty === "oct") return jwk;
  const out: Jwk = { ...jwk };
  for (const member of PRIVATE_MEMBERS) delete out[member];
  return out;
}

/**
 * Imports a JWK for `alg`. For `verify`, the private members of an
 * asymmetric JWK are dropped, so a private JWK verifies too; for `sign`,
 * the JWK must have them. Throws `key_mismatch` when the JWK does not fit.
 */
export async function importJwk(
  jwk: Jwk,
  alg: JwsAlgorithm,
  usage: Usage,
): Promise<CryptoKey> {
  if (!jwkFits(jwk, alg)) {
    throw new JwtError("key_mismatch", `JWK does not fit ${alg}`);
  }
  const source = usage === "verify" ? publicJwk(jwk) : jwk;
  if (usage === "sign" && jwk.kty !== "oct" && jwk.d === undefined) {
    throw new JwtError("key_mismatch", "a public JWK cannot sign");
  }
  const {
    kid: _kid,
    alg: _alg,
    use: _use,
    key_ops: _ops,
    ext: _ext,
    x5c: _x5c,
    x5t: _x5t,
    "x5t#S256": _x5t256,
    ...material
  } = source;
  let key: CryptoKey;
  try {
    key = await crypto.subtle.importKey(
      "jwk",
      material,
      importParams(alg),
      false,
      [usage],
    );
  } catch (cause) {
    if (isRuntimeUnsupported(cause)) {
      throw new JwtError(
        "runtime_unsupported",
        `the runtime cannot import a ${jwk.kty} JWK for ${alg}`,
        { cause },
      );
    }
    throw new JwtError("key_mismatch", `JWK import failed for ${alg}`, {
      cause,
    });
  }
  checkKey(key, alg, usage);
  return key;
}

/**
 * A `CryptoKey` for `alg` and `usage` from any {@link KeyLike}: a
 * `CryptoKey` is checked and returned, bytes are an HMAC secret, and a JWK
 * is imported with {@link importJwk}.
 */
export async function importKey(
  key: KeyLike,
  alg: JwsAlgorithm,
  usage: Usage,
): Promise<CryptoKey> {
  if (key instanceof CryptoKey) {
    checkKey(key, alg, usage);
    return key;
  }
  if (key instanceof Uint8Array) {
    if (SPECS[alg].family !== "HMAC") {
      throw new JwtError(
        "key_mismatch",
        `raw bytes are an HMAC secret, not a ${alg} key`,
      );
    }
    const imported = await crypto.subtle.importKey(
      "raw",
      Uint8Array.from(key),
      importParams(alg),
      false,
      [usage],
    );
    checkKey(imported, alg, usage);
    return imported;
  }
  return await importJwk(key, alg, usage);
}

/** A new signing key pair for an asymmetric `alg`, with its public JWK. */
export interface GeneratedKeyPair {
  readonly privateKey: CryptoKey;
  readonly publicKey: CryptoKey;
  /** The public key as a JWK with `alg` set (and `kid`, when given). */
  readonly publicJwk: Jwk;
}

/**
 * Generates a key pair for an asymmetric `alg` (for tests, and for
 * services that sign their own tokens). RSA keys have `modulusLength` bits,
 * default 2048. The private key is extractable only when asked.
 */
export async function generateKeyPair(
  alg: JwsAlgorithm,
  options: { kid?: string; modulusLength?: number; extractable?: boolean } = {},
): Promise<GeneratedKeyPair> {
  const spec = SPECS[alg];
  if (spec.family === "HMAC") {
    throw new JwtError(
      "key_mismatch",
      `${alg} is symmetric; use generateSecret`,
    );
  }
  const params = spec.family === "RSA" || spec.family === "PSS"
    ? {
      ...importParams(alg),
      modulusLength: options.modulusLength ?? MIN_RSA_BITS,
      publicExponent: new Uint8Array([1, 0, 1]),
    }
    : importParams(alg);
  const pair = await crypto.subtle.generateKey(
    params,
    options.extractable ?? false,
    ["sign", "verify"],
  ) as CryptoKeyPair;
  return {
    privateKey: pair.privateKey,
    publicKey: pair.publicKey,
    publicJwk: await exportPublicJwk(pair.publicKey, { alg, kid: options.kid }),
  };
}

/** A random HMAC secret as long as `alg`'s hash, the RFC 7518 minimum. */
export function generateSecret(alg: JwsAlgorithm): Uint8Array<ArrayBuffer> {
  const spec = SPECS[alg];
  if (spec.family !== "HMAC") {
    throw new JwtError("key_mismatch", `${alg} is not an HMAC algorithm`);
  }
  return crypto.getRandomValues(new Uint8Array(HASH_BITS[spec.hash] / 8));
}

/**
 * The public JWK of a public key (or of an extractable private key, minus
 * its private members), without `key_ops` and `ext`, with `alg` and `kid`
 * when given.
 */
export async function exportPublicJwk(
  key: CryptoKey,
  options: { alg?: JwsAlgorithm; kid?: string } = {},
): Promise<Jwk> {
  const exported = await crypto.subtle.exportKey("jwk", key) as Jwk;
  const { key_ops: _ops, ext: _ext, alg: _alg, ...jwk } = publicJwk(exported);
  return {
    ...jwk,
    ...(options.alg === undefined ? {} : { alg: options.alg }),
    ...(options.kid === undefined ? {} : { kid: options.kid }),
  };
}

const THUMBPRINT_MEMBERS: Readonly<Record<string, readonly string[]>> = {
  EC: ["crv", "kty", "x", "y"],
  OKP: ["crv", "kty", "x"],
  RSA: ["e", "kty", "n"],
  oct: ["k", "kty"],
};

/**
 * The RFC 7638 SHA-256 thumbprint of a JWK, base64url: a stable `kid`.
 * Throws `key_mismatch` for an unknown `kty` or a missing member.
 */
export async function jwkThumbprint(jwk: Jwk): Promise<string> {
  const members = THUMBPRINT_MEMBERS[jwk.kty ?? ""];
  if (members === undefined) {
    throw new JwtError("key_mismatch", `no thumbprint for kty ${jwk.kty}`);
  }
  const record = jwk as Record<string, unknown>;
  const required: Record<string, unknown> = {};
  for (const member of members) {
    if (typeof record[member] !== "string") {
      throw new JwtError("key_mismatch", `JWK has no ${member}`);
    }
    required[member] = record[member];
  }
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(JSON.stringify(required)),
  );
  return toBase64Url(new Uint8Array(digest));
}

/** The raw JWS signature of `input` under `alg` (ECDSA as `r || s`). */
export async function signBytes(
  alg: JwsAlgorithm,
  key: KeyLike,
  input: Uint8Array,
): Promise<Uint8Array<ArrayBuffer>> {
  const cryptoKey = await importKey(key, alg, "sign");
  try {
    const signature = await crypto.subtle.sign(
      signParams(alg),
      cryptoKey,
      Uint8Array.from(input),
    );
    return new Uint8Array(signature);
  } catch (cause) {
    if (!isRuntimeUnsupported(cause)) throw cause;
    throw new JwtError(
      "runtime_unsupported",
      `the runtime cannot sign with ${alg}`,
      { cause },
    );
  }
}

/**
 * Whether `signature` is `alg`'s signature of `input` under `key`. A key
 * that does not fit throws `key_mismatch`; a bad signature is `false`,
 * including one WebCrypto rejects as malformed. A runtime that does not
 * implement `alg` (celld 0.5.1 cannot verify Ed25519) throws
 * `runtime_unsupported` with its `NotSupportedError` as the cause, so it
 * is never mistaken for a bad signature.
 */
export async function verifyBytes(
  alg: JwsAlgorithm,
  key: KeyLike,
  input: Uint8Array,
  signature: Uint8Array,
): Promise<boolean> {
  const cryptoKey = await importKey(key, alg, "verify");
  try {
    return await crypto.subtle.verify(
      signParams(alg),
      cryptoKey,
      Uint8Array.from(signature),
      Uint8Array.from(input),
    );
  } catch (cause) {
    if (!isRuntimeUnsupported(cause)) return false;
    throw new JwtError(
      "runtime_unsupported",
      `the runtime cannot verify ${alg} signatures`,
      { cause },
    );
  }
}

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

import { fromBase64Url, toBase64Url } from "./base64url.ts";
import { isRuntimeUnsupported, JwtError } from "./errors.ts";

/** Every signature algorithm implemented; `none` is not one of them. */
export const JWS_ALGORITHMS = Object.freeze(
  [
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
  ] as const,
);

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

function failMember(member: string): never {
  throw new JwtError("jwks", `invalid public JWK member: ${member}`);
}

/** An untrusted JWK as a plain object of data properties, or a `jwks` error. */
function plainKey(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    failMember("key");
  }
  const key = value as Record<string, unknown>;
  if (
    Object.getPrototypeOf(key) !== Object.prototype &&
    Object.getPrototypeOf(key) !== null
  ) failMember("prototype");
  if (
    Reflect.ownKeys(key).some((name) => typeof name !== "string") ||
    Object.values(Object.getOwnPropertyDescriptors(key)).some((d) =>
      !Object.hasOwn(d, "value")
    )
  ) failMember("descriptor");
  return key;
}

/** The members of secret and private key material (RFC 7518 section 6). */
const SECRET_MEMBERS = [
  "k",
  "d",
  "p",
  "q",
  "dp",
  "dq",
  "qi",
  "oth",
  "priv",
] as const;

/** Curves that only agree keys (ECDH-ES), never sign. */
const KEY_AGREEMENT_CURVES = ["X25519", "X448"];

/**
 * The verification keys of a public JWK Set's `keys`, each checked by
 * {@link validatePublicJwk}, skipping the keys that say they are for
 * something else: a `use` other than `sig`, an `alg` that is not a JWS
 * algorithm (`ECDH-ES`, `RSA-OAEP-256`), `key_ops` with neither `sign` nor
 * `verify`, or a key-agreement curve (X25519, X448). A set may mix signing
 * and encryption keys (OpenID Connect Discovery's `jwks_uri`), and RFC 7517
 * section 5 has an implementation ignore the keys it cannot use; a key
 * that says nothing of its purpose is a signing key and is held to the
 * signing rules. Secret and private material refuses the whole set
 * whatever the key is for (`oct`, or any of `k`, `d`, `p`, `q`, `dp`,
 * `dq`, `qi`, `oth`, `priv`): the set is public, so the secret is too.
 */
export function publicVerificationKeys(keys: readonly unknown[]): Jwk[] {
  const verification: Jwk[] = [];
  for (const value of keys) {
    const key = plainKey(value);
    if (key.kty === "oct") failMember("kty");
    for (const member of SECRET_MEMBERS) {
      if (Object.hasOwn(key, member)) failMember(member);
    }
    const ops = key.key_ops;
    const otherPurpose = (typeof key.use === "string" && key.use !== "sig") ||
      (typeof key.alg === "string" && !isJwsAlgorithm(key.alg)) ||
      (Array.isArray(ops) && !ops.includes("sign") &&
        !ops.includes("verify")) ||
      (key.kty === "OKP" && KEY_AGREEMENT_CURVES.includes(key.crv as string));
    if (!otherPurpose) verification.push(validatePublicJwk(key));
  }
  return verification;
}

/**
 * Validate untrusted public signature key material and take an immutable copy.
 * Extensions are deliberately refused: the accepted members are JOSE metadata
 * and the public members of RSA, EC and Ed25519 keys. This boundary must never
 * be used to sanitize a leaked private key; the entire key is rejected.
 */
export function validatePublicJwk(value: unknown): Jwk {
  const fail = failMember;
  const key = plainKey(value);
  const fields = key.kty === "RSA"
    ? ["n", "e"]
    : key.kty === "EC"
    ? ["crv", "x", "y"]
    : key.kty === "OKP"
    ? ["crv", "x"]
    : fail("kty");
  const allowed = new Set([
    "kty",
    "kid",
    "alg",
    "use",
    "key_ops",
    "ext",
    "x5c",
    "x5t",
    "x5t#S256",
    "x5u",
    ...fields,
  ]);
  for (const name of Object.keys(key)) {
    if (!allowed.has(name)) fail(name);
  }
  for (const name of fields) {
    if (
      typeof key[name] !== "string" || key[name].length === 0 ||
      key[name].length > 4096
    ) fail(name);
  }
  for (const name of ["kid", "alg", "x5t", "x5t#S256", "x5u"]) {
    if (
      key[name] !== undefined &&
      (typeof key[name] !== "string" || key[name].length === 0 ||
        key[name].length > (name === "kid" ? 256 : 2048))
    ) fail(name);
  }
  if (key.use !== undefined && key.use !== "sig") fail("use");
  if (key.ext !== undefined && typeof key.ext !== "boolean") fail("ext");
  if (
    key.key_ops !== undefined &&
    (!Array.isArray(key.key_ops) || key.key_ops.length !== 1 ||
      key.key_ops[0] !== "verify")
  ) fail("key_ops");
  if (
    key.x5c !== undefined &&
    (!Array.isArray(key.x5c) || key.x5c.length > 8 ||
      !key.x5c.every((v) => typeof v === "string" && v.length <= 16384))
  ) fail("x5c");
  const bytes = (name: string): Uint8Array => {
    const result = fromBase64Url(key[name] as string);
    if (result === null || result.length === 0) fail(name);
    return result!;
  };
  if (key.kty === "RSA") {
    const n = bytes("n");
    if (
      n[0] === 0 || n.length > 1024 ||
      (n.length - 1) * 8 + 32 - Math.clz32(n[0]) < MIN_RSA_BITS
    ) fail("n");
    const e = bytes("e");
    if (e.length > 4 || e[0] === 0) fail("e");
    let exponent = 0;
    for (const b of e) exponent = exponent * 256 + b;
    if (exponent < 3 || exponent % 2 === 0) fail("e");
  } else {
    const size = key.kty === "OKP" && key.crv === "Ed25519"
      ? 32
      : key.kty === "EC" && key.crv === "P-256"
      ? 32
      : key.kty === "EC" && key.crv === "P-384"
      ? 48
      : key.kty === "EC" && key.crv === "P-521"
      ? 66
      : fail("crv");
    if (bytes("x").length !== size) fail("x");
    if (key.kty === "EC" && bytes("y").length !== size) fail("y");
  }
  if (
    key.alg !== undefined &&
    (!isJwsAlgorithm(key.alg) || isHmac(key.alg) ||
      !jwkFits(key as Jwk, key.alg))
  ) fail("alg");
  return Object.freeze({
    ...key,
    ...(key.key_ops === undefined
      ? {}
      : { key_ops: Object.freeze([...key.key_ops as string[]]) }),
    ...(key.x5c === undefined
      ? {}
      : { x5c: Object.freeze([...key.x5c as string[]]) }),
  }) as Jwk;
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

/** What a key is used for. */
export type KeyUsage = "sign" | "verify";
type Usage = KeyUsage;

const SIGNATURE_OPS: ReadonlySet<string> = new Set(["sign", "verify"]);

/** The public operation matching each private one (RFC 7517 section 4.3). */
const PUBLIC_OPS: Readonly<Record<string, string>> = {
  sign: "verify",
  decrypt: "encrypt",
  unwrapKey: "wrapKey",
};

function isPrivateJwk(jwk: Jwk): boolean {
  return jwk.kty !== "oct" && jwk.d !== undefined;
}

/**
 * Why a JWK's `key_ops` is unacceptable, or null: it must be a non-empty
 * list of distinct strings (RFC 7517 section 4.3), and with `use: "sig"`
 * only `sign` and `verify`, with `use: "enc"` neither of them.
 */
export function keyOpsProblem(jwk: Jwk): string | null {
  const ops: unknown = jwk.key_ops;
  if (ops === undefined) return null;
  if (!Array.isArray(ops) || ops.length === 0) {
    return "key_ops must be a non-empty list";
  }
  const seen = new Set<string>();
  for (const op of ops) {
    if (typeof op !== "string") return "key_ops must hold strings";
    if (seen.has(op)) return `key_ops names ${op} twice`;
    seen.add(op);
  }
  if (jwk.use === "sig" && ops.some((op) => !SIGNATURE_OPS.has(op))) {
    return "key_ops does not match use sig";
  }
  if (jwk.use === "enc" && ops.some((op) => SIGNATURE_OPS.has(op))) {
    return "key_ops does not match use enc";
  }
  return null;
}

/**
 * Whether a JWK's `key_ops`, if any, allow `usage`. A private asymmetric
 * JWK whose `key_ops` allow `sign` also verifies (as its public half).
 */
function keyOpsAllow(jwk: Jwk, usage: Usage): boolean {
  if (keyOpsProblem(jwk) !== null) return false;
  const ops = jwk.key_ops;
  if (ops === undefined) return true;
  if (ops.includes(usage)) return true;
  return usage === "verify" && isPrivateJwk(jwk) && ops.includes("sign");
}

/**
 * Whether a JWK can be used with `alg` for `usage` (default `verify`): its
 * `kty` and `crv` match; its `alg` and `use`, when present, are `alg` and
 * `sig`; and its `key_ops`, when present, are well formed, agree with
 * `use`, and allow `usage`. An RSA JWK without `alg` fits both RS* and
 * PS*; `verify`, key sets and `createVerifier` each bind it to one.
 */
export function jwkFits(
  jwk: Jwk,
  alg: JwsAlgorithm,
  usage: Usage = "verify",
): boolean {
  if (jwk.alg !== undefined && jwk.alg !== alg) {
    const eddsa = (a: unknown) => a === "EdDSA" || a === "Ed25519";
    if (!(eddsa(jwk.alg) && eddsa(alg))) return false;
  }
  if (jwk.use !== undefined && jwk.use !== "sig") return false;
  if (!keyOpsAllow(jwk, usage)) return false;
  const shape = jwkShape(alg);
  return jwk.kty === shape.kty &&
    (shape.crv === undefined || jwk.crv === shape.crv);
}

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

/** The key members of each asymmetric `kty` that are public. */
const PUBLIC_MEMBERS: Readonly<Record<string, readonly string[]>> = {
  EC: ["crv", "x", "y"],
  OKP: ["crv", "x"],
  RSA: ["n", "e"],
};
/** The metadata members any public JWK may carry (RFC 7517 section 4). */
const PUBLIC_METADATA = [
  "kid",
  "alg",
  "use",
  "key_ops",
  "x5c",
  "x5t",
  "x5t#S256",
  "x5u",
] as const;

/**
 * The public half of an asymmetric JWK: `kty`, the public members of its
 * key type (RSA `n`, `e`; EC `crv`, `x`, `y`; OKP `crv`, `x`) and the
 * metadata `kid`, `alg`, `use`, `key_ops`, `x5c`, `x5t`, `x5t#S256` and
 * `x5u`, and nothing else, so a private member of any name stays out. When
 * present, `key_ops` is translated to the public operations (`sign` to
 * `verify`, and so on). A symmetric (`oct`) key has no public half, so it
 * throws `secret_key`: a secret must never be published. Any other `kty`
 * throws `key_mismatch`, since which of its members are private is not
 * known here.
 */
export function publicJwk(jwk: Jwk): Jwk {
  if (jwk.kty === "oct" || Object.hasOwn(jwk, "k")) {
    throw new JwtError(
      "secret_key",
      "a symmetric JWK is secret and has no public form",
    );
  }
  const kty = jwk.kty ?? "";
  const members = Object.hasOwn(PUBLIC_MEMBERS, kty)
    ? PUBLIC_MEMBERS[kty]
    : undefined;
  if (members === undefined) {
    throw new JwtError(
      "key_mismatch",
      `no public form is known for kty ${JSON.stringify(jwk.kty)}`,
    );
  }
  const source = jwk as Record<string, unknown>;
  const out: Record<string, unknown> = { kty };
  for (const member of [...members, ...PUBLIC_METADATA]) {
    if (Object.hasOwn(source, member) && source[member] !== undefined) {
      out[member] = source[member];
    }
  }
  if (Array.isArray(jwk.key_ops)) {
    out.key_ops = [
      ...new Set(
        jwk.key_ops.map((op) =>
          Object.hasOwn(PUBLIC_OPS, op) ? PUBLIC_OPS[op] : op
        ),
      ),
    ];
  }
  return out as Jwk;
}

/**
 * What verifies with `jwk`: its public half, or for a symmetric key the
 * secret itself. Internal: never publish its result.
 */
function verificationMaterial(jwk: Jwk): Jwk {
  return jwk.kty === "oct" ? jwk : publicJwk(jwk);
}

/**
 * Imports a JWK for `alg`. For `verify`, the private members of an
 * asymmetric JWK are dropped, so a private JWK verifies too; for `sign`,
 * the JWK must have them. Throws `key_mismatch` when the JWK does not fit
 * (see {@link jwkFits}, including its `key_ops`). WebCrypto gets
 * `key_ops: [usage]` when the JWK restricts its operations, and the key's
 * usages are exactly `[usage]`.
 */
export async function importJwk(
  jwk: Jwk,
  alg: JwsAlgorithm,
  usage: Usage,
): Promise<CryptoKey> {
  const problem = keyOpsProblem(jwk);
  if (problem !== null) throw new JwtError("key_mismatch", problem);
  if (!jwkFits(jwk, alg, usage)) {
    throw new JwtError("key_mismatch", `JWK does not fit ${alg} to ${usage}`);
  }
  const source = usage === "verify" ? verificationMaterial(jwk) : jwk;
  if (usage === "sign" && jwk.kty !== "oct" && jwk.d === undefined) {
    throw new JwtError("key_mismatch", "a public JWK cannot sign");
  }
  const {
    kid: _kid,
    alg: _alg,
    use: _use,
    key_ops: ops,
    ext: _ext,
    x5c: _x5c,
    x5t: _x5t,
    "x5t#S256": _x5t256,
    ...rest
  } = source;
  const material: JsonWebKey = ops === undefined
    ? rest
    : { ...rest, key_ops: [usage] };
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

/**
 * Whether `key` can verify `alg`, judged without importing it: a
 * `CryptoKey` by {@link checkKey}, bytes as an HMAC secret at least as
 * long as the hash, a JWK by {@link jwkFits}. Internal to the package.
 */
export function keyLikeFits(key: KeyLike, alg: JwsAlgorithm): boolean {
  if (key instanceof CryptoKey) {
    try {
      checkKey(key, alg, "verify");
      return true;
    } catch {
      return false;
    }
  }
  if (key instanceof Uint8Array) {
    const spec = SPECS[alg];
    return spec.family === "HMAC" && key.length * 8 >= HASH_BITS[spec.hash];
  }
  return jwkFits(key, alg, "verify");
}

/**
 * Whether `alg` is RSA-PSS (PS256/384/512). Internal to the package.
 */
export function isPss(alg: JwsAlgorithm): boolean {
  return SPECS[alg].family === "PSS";
}

/** Whether `alg` is HMAC (HS256/384/512). Internal to the package. */
export function isHmac(alg: JwsAlgorithm): boolean {
  return SPECS[alg].family === "HMAC";
}

/**
 * Whether two algorithm names are one WebCrypto operation (`EdDSA` and
 * `Ed25519`). Internal to the package.
 */
export function sameAlgorithm(a: JwsAlgorithm, b: JwsAlgorithm): boolean {
  return a === b || (SPECS[a].family === "OKP" && SPECS[b].family === "OKP");
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
  if (!isJwsAlgorithm(alg)) {
    throw new JwtError(
      "unsupported_alg",
      "unsupported key-generation algorithm",
    );
  }
  if (
    options.extractable !== undefined &&
    typeof options.extractable !== "boolean"
  ) throw new TypeError("extractable must be boolean");
  if (
    options.kid !== undefined &&
    (typeof options.kid !== "string" || options.kid.length === 0 ||
      options.kid.length > 256)
  ) throw new TypeError("kid must contain 1 to 256 characters");
  const spec = SPECS[alg];
  if (spec.family === "HMAC") {
    throw new JwtError(
      "key_mismatch",
      `${alg} is symmetric; use generateSecret`,
    );
  }
  if (
    options.modulusLength !== undefined &&
    (spec.family !== "RSA" && spec.family !== "PSS" ||
      !Number.isSafeInteger(options.modulusLength) ||
      options.modulusLength < MIN_RSA_BITS || options.modulusLength > 8192 ||
      options.modulusLength % 8 !== 0)
  ) {
    throw new RangeError(
      "RSA modulusLength must be a multiple of 8 from 2048 to 8192",
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
  if (!isJwsAlgorithm(alg)) {
    throw new JwtError("unsupported_alg", "unsupported secret algorithm");
  }
  const spec = SPECS[alg];
  if (spec.family !== "HMAC") {
    throw new JwtError("key_mismatch", `${alg} is not an HMAC algorithm`);
  }
  return crypto.getRandomValues(new Uint8Array(HASH_BITS[spec.hash] / 8));
}

const capabilityChecks = new Map<JwsAlgorithm, Promise<void>>();

/** Probe configured crypto operations once at readiness, before serving traffic. */
export async function assertAlgorithmsSupported(
  algorithms: readonly JwsAlgorithm[],
): Promise<void> {
  if (!Array.isArray(algorithms) || algorithms.length === 0) {
    throw new TypeError("a nonempty algorithm policy is required");
  }
  await Promise.all(algorithms.map((alg) => {
    if (!isJwsAlgorithm(alg)) {
      throw new JwtError("unsupported_alg", "unsupported configured algorithm");
    }
    let probe = capabilityChecks.get(alg);
    if (probe === undefined) {
      probe = (async () => {
        try {
          const pair = isHmac(alg) ? null : await generateKeyPair(alg);
          const signing = pair?.privateKey ?? generateSecret(alg);
          const verifying = pair?.publicKey ?? signing;
          const input = new TextEncoder().encode("@celld/sec/jwt readiness v1");
          const signature = await signBytes(alg, signing, input);
          if (!await verifyBytes(alg, verifying, input, signature)) {
            throw new Error("cryptographic self-test failed");
          }
        } catch (cause) {
          if (
            cause instanceof JwtError && cause.code === "runtime_unsupported"
          ) throw cause;
          throw new JwtError(
            "runtime_unsupported",
            "configured cryptographic operation is unavailable",
            { cause },
          );
        }
      })();
      capabilityChecks.set(alg, probe);
    }
    return probe;
  }));
}

/**
 * The public JWK of a public key (or of an extractable private key, minus
 * its private members), without `key_ops` and `ext`, with `alg` and `kid`
 * when given. A secret (HMAC) key throws `secret_key`.
 */
export async function exportPublicJwk(
  key: CryptoKey,
  options: { alg?: JwsAlgorithm; kid?: string } = {},
): Promise<Jwk> {
  if (key.type === "secret") {
    throw new JwtError(
      "secret_key",
      "a secret key has no public form",
    );
  }
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
 * A string that changes whenever what `jwk` verifies with does: its RFC
 * 7638 thumbprint members and `alg`, `use` and `key_ops`, or all its
 * members for an unknown `kty`. Computed synchronously on every lookup, it
 * keys import caches over sets that may change in place. Internal to the
 * package; it may hold secret material, so it never leaves memory.
 */
export function jwkFingerprint(jwk: Jwk): string {
  const record = jwk as Record<string, unknown>;
  const kty = typeof jwk.kty === "string" ? jwk.kty : "";
  const members = Object.hasOwn(THUMBPRINT_MEMBERS, kty)
    ? [...THUMBPRINT_MEMBERS[kty], "alg", "use", "key_ops"]
    : Object.keys(record).sort();
  return JSON.stringify(
    members.map((member) =>
      Object.hasOwn(record, member) ? record[member] ?? null : null
    ),
  ) + JSON.stringify(members);
}

/**
 * The RFC 7638 SHA-256 thumbprint of a JWK, base64url: a stable `kid`.
 * Throws `key_mismatch` for an unknown `kty` or a missing member.
 */
export async function jwkThumbprint(jwk: Jwk): Promise<string> {
  // `kty` comes from the peer: a prototype name is just an unknown type.
  const kty = jwk.kty ?? "";
  const members = Object.hasOwn(THUMBPRINT_MEMBERS, kty)
    ? THUMBPRINT_MEMBERS[kty]
    : undefined;
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
 * implement `alg` throws `runtime_unsupported` with its
 * `NotSupportedError` as the cause, so it is never mistaken for a bad
 * signature.
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

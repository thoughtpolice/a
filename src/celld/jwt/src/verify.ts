// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * {@link verify}: a token's signature, then its claims.
 *
 * @module
 */

import { decode, type JwtClaims, type JwtHeader } from "./decode.ts";
import { JwtError } from "./errors.ts";
import { type KeySet, localJwks } from "./jwks.ts";
import {
  isJwsAlgorithm,
  type Jwks,
  type JwsAlgorithm,
  type KeyLike,
  verifyBytes,
} from "./keys.ts";

/**
 * What {@link verify} checks the token against: a key (a `CryptoKey`, a
 * JWK or an HMAC secret), a JWKS, or a {@link KeySet} such as `RemoteJwks`.
 */
export type VerifyKey = KeyLike | Jwks | KeySet;

/** The current time: a `Date`, epoch milliseconds, or a clock returning them. */
export type Now = Date | number | (() => number);

/** What {@link verify} requires of a token beyond its signature. */
export interface VerifyOptions {
  /** The accepted `alg` values; default every one this library implements. */
  readonly algorithms?: readonly JwsAlgorithm[];
  /** `iss` must be this, or one of these. */
  readonly issuer?: string | readonly string[];
  /** `aud` (a string or a list) must name this, or one of these. */
  readonly audience?: string | readonly string[];
  /** `sub` must be this. */
  readonly subject?: string;
  /**
   * The header's `typ` must be one of these, compared without case and
   * with an `application/` prefix ignored (RFC 7515 section 4.1.9).
   */
  readonly typ?: string | readonly string[];
  /** Claims the token must have, beyond those the options above imply. */
  readonly requiredClaims?: readonly string[];
  /** Header parameters the caller understands; any other `crit` name fails. */
  readonly crit?: readonly string[];
  /** Seconds of clock skew allowed for `exp`, `nbf` and `iat`; default 0. */
  readonly clockTolerance?: number;
  /** The oldest `iat` accepted, in seconds before now; requires `iat`. */
  readonly maxTokenAge?: number;
  /** Default `Date.now`. */
  readonly now?: Now;
}

/** A token whose signature and claims passed. */
export interface VerifiedJwt<C extends JwtClaims = JwtClaims> {
  readonly header: JwtHeader;
  readonly payload: C;
  readonly alg: JwsAlgorithm;
}

/** Epoch milliseconds for a {@link Now}. */
export function nowMs(now: Now | undefined): number {
  if (now === undefined) return Date.now();
  if (typeof now === "function") return now();
  return typeof now === "number" ? now : now.getTime();
}

function list<T>(
  value: T | readonly T[] | undefined,
): readonly T[] | undefined {
  if (value === undefined) return undefined;
  return Array.isArray(value) ? value : [value as T];
}

function isKeySet(key: VerifyKey): key is KeySet {
  return typeof (key as Partial<KeySet>).resolve === "function";
}

function isJwks(key: VerifyKey): key is Jwks {
  return Array.isArray((key as Partial<Jwks>).keys);
}

const jwksSets = new WeakMap<Jwks, KeySet>();

function jwksSet(jwks: Jwks): KeySet {
  let set = jwksSets.get(jwks);
  if (set === undefined) {
    set = localJwks(jwks);
    jwksSets.set(jwks, set);
  }
  return set;
}

function mediaType(typ: string): string {
  const lower = typ.toLowerCase();
  return lower.startsWith("application/") ? lower.slice(12) : lower;
}

function numericDate(
  claims: JwtClaims,
  name: "exp" | "nbf" | "iat",
): number | undefined {
  const value = claims[name];
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new JwtError("invalid_claim", `${name} must be a number`);
  }
  return value;
}

function checkClaims(claims: JwtClaims, options: VerifyOptions): void {
  const required = new Set(options.requiredClaims);
  if (options.issuer !== undefined) required.add("iss");
  if (options.audience !== undefined) required.add("aud");
  if (options.subject !== undefined) required.add("sub");
  if (options.maxTokenAge !== undefined) required.add("iat");
  for (const name of required) {
    if (claims[name] === undefined) {
      throw new JwtError("missing_claim", `the token has no ${name}`);
    }
  }
  for (const name of ["iss", "sub", "jti"] as const) {
    if (claims[name] !== undefined && typeof claims[name] !== "string") {
      throw new JwtError("invalid_claim", `${name} must be a string`);
    }
  }
  const aud = claims.aud;
  const audiences = aud === undefined ? [] : Array.isArray(aud) ? aud : [aud];
  if (!audiences.every((item) => typeof item === "string")) {
    throw new JwtError("invalid_claim", "aud must be a string or strings");
  }
  const clock = nowMs(options.now) / 1000;
  const tolerance = options.clockTolerance ?? 0;
  const exp = numericDate(claims, "exp");
  const nbf = numericDate(claims, "nbf");
  const iat = numericDate(claims, "iat");
  if (exp !== undefined && clock >= exp + tolerance) {
    throw new JwtError("expired", "the token has expired");
  }
  if (nbf !== undefined && clock < nbf - tolerance) {
    throw new JwtError("not_yet_valid", "the token is not valid yet");
  }
  if (options.maxTokenAge !== undefined && iat !== undefined) {
    if (clock - iat > options.maxTokenAge + tolerance) {
      throw new JwtError("too_old", "the token was issued too long ago");
    }
    if (iat > clock + tolerance) {
      throw new JwtError("not_yet_valid", "the token was issued in the future");
    }
  }
  const issuers = list(options.issuer);
  if (issuers !== undefined && !issuers.includes(claims.iss as string)) {
    throw new JwtError(
      "issuer",
      `unexpected issuer ${JSON.stringify(claims.iss)}`,
    );
  }
  const expected = list(options.audience);
  if (
    expected !== undefined && !audiences.some((item) => expected.includes(item))
  ) {
    throw new JwtError("audience", "the token is not for this audience");
  }
  if (options.subject !== undefined && claims.sub !== options.subject) {
    throw new JwtError(
      "subject",
      `unexpected subject ${JSON.stringify(claims.sub)}`,
    );
  }
}

/**
 * Verifies a compact JWS and its claims, in this order: it decodes; `alg`
 * is implemented (never `none`) and allowed; every `crit` name is in
 * `options.crit`; `typ` is expected; the key fits `alg` (an RSA key is
 * never used as an HMAC secret, or the other way round) and the signature
 * verifies; then the claims. Throws a {@link JwtError} saying which check
 * failed. `exp`, `nbf` and `iat` are checked whenever present;
 * `requiredClaims` makes them mandatory.
 */
export async function verify<C extends JwtClaims = JwtClaims>(
  token: string,
  key: VerifyKey,
  options: VerifyOptions = {},
): Promise<VerifiedJwt<C>> {
  const jwt = decode<C>(token);
  const alg = jwt.header.alg;
  if (!isJwsAlgorithm(alg)) {
    throw new JwtError(
      "unsupported_alg",
      `unsupported alg ${JSON.stringify(alg)}`,
    );
  }
  if (options.algorithms !== undefined && !options.algorithms.includes(alg)) {
    throw new JwtError("alg_not_allowed", `alg ${alg} is not allowed`);
  }
  for (const name of jwt.header.crit ?? []) {
    if (!options.crit?.includes(name)) {
      throw new JwtError(
        "crit",
        `critical header ${JSON.stringify(name)} is not understood`,
      );
    }
  }
  const types = list(options.typ);
  if (types !== undefined) {
    const typ = jwt.header.typ;
    if (
      typeof typ !== "string" ||
      !types.some((item) => mediaType(item) === mediaType(typ))
    ) {
      throw new JwtError("typ", `unexpected typ ${JSON.stringify(typ)}`);
    }
  }
  const cryptoKey = isKeySet(key)
    ? await key.resolve(jwt.header, alg)
    : isJwks(key)
    ? await jwksSet(key).resolve(jwt.header, alg)
    : key;
  if (!(await verifyBytes(alg, cryptoKey, jwt.signingInput, jwt.signature))) {
    throw new JwtError("bad_signature", "the signature does not verify");
  }
  checkClaims(jwt.payload, options);
  return { header: jwt.header, payload: jwt.payload, alg };
}

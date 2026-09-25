// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * Reading a compact JWS without verifying it: the typed header and
 * claims, the signature bytes, and a structural {@link isJwt} test.
 *
 * @module
 */

import { BoundsError, parseJsonBounded } from "@celld/core/bounds";
import { fromBase64Url } from "./base64url.ts";
import { JwtError } from "./errors.ts";
import { type JwtLimits, resolveLimits } from "./limits.ts";

/**
 * A JOSE header (RFC 7515 section 4.1). {@link decode} checks the JSON type
 * of every member named here, so a present `kid` is a string, and so on.
 */
export interface JwtHeader {
  readonly alg: string;
  readonly typ?: string;
  readonly cty?: string;
  readonly kid?: string;
  readonly crit?: readonly string[];
  readonly jku?: string;
  readonly jwk?: Readonly<Record<string, unknown>>;
  readonly x5u?: string;
  readonly x5c?: readonly string[];
  readonly x5t?: string;
  readonly "x5t#S256"?: string;
  readonly [key: string]: unknown;
}

/** A JWT claims set: the registered claims (RFC 7519 section 4.1) and any others. */
export interface JwtClaims {
  readonly iss?: string;
  readonly sub?: string;
  readonly aud?: string | readonly string[];
  /** Seconds since the epoch. */
  readonly exp?: number;
  /** Seconds since the epoch. */
  readonly nbf?: number;
  /** Seconds since the epoch. */
  readonly iat?: number;
  readonly jti?: string;
  readonly [key: string]: unknown;
}

/** A compact JWS, decoded but not verified. */
export interface DecodedJwt {
  readonly header: JwtHeader;
  /**
   * The claims as they are in the token; nothing about them is checked,
   * not even the types of the registered claims.
   */
  readonly payload: JwtClaims;
  readonly signature: Uint8Array<ArrayBuffer>;
  /** `header.payload` as ASCII bytes: what the signature covers. */
  readonly signingInput: Uint8Array<ArrayBuffer>;
}

/** Options for {@link decode}. */
export interface DecodeOptions {
  /** Size caps; see {@link JwtLimits}. */
  readonly limits?: JwtLimits;
}

/**
 * The header parameters registered for JWS and JWE (RFC 7515 section 4.1,
 * RFC 7516 section 4.1, RFC 7518 section 4.6 to 4.8). `crit` may not name
 * them: their meaning is already fixed.
 */
export const REGISTERED_HEADER_PARAMETERS: readonly string[] = Object.freeze([
  "alg",
  "jku",
  "jwk",
  "kid",
  "x5u",
  "x5c",
  "x5t",
  "x5t#S256",
  "typ",
  "cty",
  "crit",
  "enc",
  "zip",
  "epk",
  "apu",
  "apv",
  "iv",
  "tag",
  "p2s",
  "p2c",
]);

const STRING_MEMBERS = [
  "typ",
  "cty",
  "kid",
  "jku",
  "x5u",
  "x5t",
  "x5t#S256",
] as const;

const HEADER_JSON = { maxDepth: 8, maxKeys: 64, maxItems: 64 };
const PAYLOAD_JSON = { maxDepth: 32, maxKeys: 1024, maxItems: 8192 };

const decoder = new TextDecoder("utf-8", { fatal: true });
const encoder = new TextEncoder();

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStrings(value: unknown): value is string[] {
  return Array.isArray(value) &&
    value.every((item) => typeof item === "string");
}

function malformed(message: string): JwtError {
  return new JwtError("malformed", message);
}

/** Structural registered-claim checks shared by safe signing and verification. */
export function checkClaimStructure(claims: JwtClaims): void {
  for (const name of ["iss", "sub", "jti"] as const) {
    const value = claims[name];
    if (
      value !== undefined &&
      (typeof value !== "string" || value.length === 0 || value.length > 2048)
    ) {
      throw new JwtError(
        "invalid_claim",
        `${name} must be a bounded non-empty string`,
      );
    }
  }
  for (const name of ["exp", "nbf", "iat"] as const) {
    const value = claims[name];
    if (
      value !== undefined &&
      (typeof value !== "number" || !Number.isFinite(value) ||
        Math.abs(value) > 8.64e12)
    ) {
      throw new JwtError(
        "invalid_claim",
        `${name} must be a finite numeric date`,
      );
    }
  }
  const audience = claims.aud;
  if (audience !== undefined) {
    const values = typeof audience === "string" ? [audience] : audience;
    if (
      !Array.isArray(values) || values.length === 0 || values.length > 64 ||
      !values.every((value) =>
        typeof value === "string" && value.length > 0 && value.length <= 2048
      ) || new Set(values).size !== values.length
    ) {
      throw new JwtError(
        "invalid_claim",
        "aud must contain distinct bounded non-empty strings",
      );
    }
  }
  if (claims.cnf !== undefined) {
    if (!isObject(claims.cnf) || Object.keys(claims.cnf).length > 16) {
      throw new JwtError("invalid_claim", "cnf must be an object");
    }
    for (const name of ["jkt", "jku", "kid", "x5t#S256"]) {
      const value = claims.cnf[name];
      if (
        value !== undefined &&
        (typeof value !== "string" || value.length === 0 || value.length > 2048)
      ) throw new JwtError("invalid_claim", "cnf contains an invalid member");
    }
  }
}

/**
 * Throws unless `header` is a JOSE header this library accepts: `alg` a
 * string; `typ`, `cty`, `kid`, `jku`, `x5u`, `x5t` and `x5t#S256`, when
 * present, strings; `x5c` a list of strings; `jwk` an object (`malformed`
 * otherwise). `b64` (RFC 7797) is not implemented, so any `b64` member is
 * `unsupported`. `crit`, when present, is a non-empty list (`malformed`)
 * of distinct names, each present in the header and none of them a
 * registered parameter (`crit`); see RFC 7515 section 4.1.11.
 */
export function checkHeader(header: Readonly<Record<string, unknown>>): void {
  if (typeof header.alg !== "string") throw malformed("the header has no alg");
  for (const name of STRING_MEMBERS) {
    if (
      header[name] !== undefined &&
      (typeof header[name] !== "string" || header[name].length === 0 ||
        header[name].length > (name === "kid" ? 256 : 2048))
    ) {
      throw malformed(`the header's ${name} must be a string`);
    }
  }
  if (header.x5c !== undefined && !isStrings(header.x5c)) {
    throw malformed("the header's x5c must be a list of strings");
  }
  if (header.jwk !== undefined && !isObject(header.jwk)) {
    throw malformed("the header's jwk must be an object");
  }
  if (Object.hasOwn(header, "b64")) {
    throw new JwtError(
      "unsupported",
      "the b64 header parameter (RFC 7797) is not supported",
    );
  }
  const crit = header.crit;
  if (crit === undefined) return;
  if (
    !isStrings(crit) || crit.length === 0 || crit.length > 16 ||
    crit.some((name) => name.length === 0 || name.length > 128)
  ) {
    throw malformed("crit must be a non-empty list of names");
  }
  const seen = new Set<string>();
  for (const name of crit) {
    if (seen.has(name)) {
      throw new JwtError("crit", `crit names ${JSON.stringify(name)} twice`);
    }
    seen.add(name);
    if (REGISTERED_HEADER_PARAMETERS.includes(name)) {
      throw new JwtError(
        "crit",
        `crit may not name the registered parameter ${JSON.stringify(name)}`,
      );
    }
    if (!Object.hasOwn(header, name)) {
      throw new JwtError(
        "crit",
        `crit names ${JSON.stringify(name)}, which the header lacks`,
      );
    }
  }
}

function json(
  part: string,
  what: string,
  maxBytes: number,
  limits: typeof HEADER_JSON,
): Record<string, unknown> {
  if (Math.floor(part.length * 3 / 4) > maxBytes) {
    throw new JwtError("too_large", `the ${what} is over ${maxBytes} bytes`);
  }
  const bytes = fromBase64Url(part);
  if (bytes === null) {
    throw malformed(`the ${what} is not base64url`);
  }
  let value: unknown;
  try {
    value = parseJsonBounded(decoder.decode(bytes), limits);
  } catch (cause) {
    const code = cause instanceof BoundsError &&
        (cause.code === "too_large" || cause.code === "too_many" ||
          cause.code === "too_deep")
      ? "too_large"
      : "malformed";
    throw new JwtError(code, `the ${what} is not acceptable JSON`, { cause });
  }
  if (!isObject(value)) {
    throw malformed(`the ${what} is not a JSON object`);
  }
  return value;
}

/**
 * Decodes a compact JWS whose payload is a JSON object, without verifying
 * anything. A token over the size limits is `too_large`, refused before
 * any part is decoded; base64url must be canonical and its alphabet is
 * checked before any bytes are allocated; the JSON may not repeat a key or
 * use `__proto__`, `constructor` or `prototype` as one. The header must
 * pass {@link checkHeader}. Everything else is `malformed`. Nothing it
 * returns is trustworthy until `verify` has checked it.
 */
export function decode(token: string, options: DecodeOptions = {}): DecodedJwt {
  const limits = resolveLimits(options.limits);
  if (typeof token !== "string") throw malformed("a token is a string");
  if (token.length > limits.maxTokenBytes) {
    throw new JwtError(
      "too_large",
      `the token is over ${limits.maxTokenBytes} bytes`,
    );
  }
  const parts = token.split(".");
  if (parts.length !== 3) {
    throw malformed("a compact JWS has three parts");
  }
  const header = json(parts[0], "header", limits.maxHeaderBytes, HEADER_JSON);
  checkHeader(header);
  const payload = json(
    parts[1],
    "payload",
    limits.maxPayloadBytes,
    PAYLOAD_JSON,
  );
  const signature = fromBase64Url(parts[2]);
  if (signature === null) {
    throw malformed("the signature is not base64url");
  }
  return {
    header: header as JwtHeader,
    payload,
    signature,
    signingInput: encoder.encode(`${parts[0]}.${parts[1]}`),
  };
}

/** {@link decode}, or null instead of a throw. */
export function tryDecode(
  token: string,
  options: DecodeOptions = {},
): DecodedJwt | null {
  try {
    return decode(token, options);
  } catch {
    return null;
  }
}

/** Options for {@link isJwt}. */
export interface IsJwtOptions {
  /** The header's `alg` must be this. */
  readonly alg?: string;
}

/**
 * Whether `token` looks like a JWT: it decodes (see {@link decode}), a
 * `typ`, when present, is `JWT` or ends in `+jwt` (either case, RFC 8725
 * explicit typing), and the signature is not empty unless `alg` is `none`.
 * Nothing is verified.
 */
export function isJwt(token: string, options: IsJwtOptions = {}): boolean {
  const jwt = tryDecode(token);
  if (jwt === null) return false;
  const { alg, typ } = jwt.header;
  if (options.alg !== undefined && alg !== options.alg) return false;
  if (typ !== undefined) {
    if (typeof typ !== "string") return false;
    const lower = typ.toLowerCase();
    if (lower !== "jwt" && !lower.endsWith("+jwt")) return false;
  }
  return jwt.signature.length > 0 || alg === "none";
}

/** The regular expression source JSON Schema uses for a compact JWS. */
export const JWT_PATTERN = "^[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]*$";

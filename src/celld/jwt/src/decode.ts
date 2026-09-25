// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * Reading a compact JWS without verifying it: the typed header and
 * claims, the signature bytes, and a structural {@link isJwt} test.
 *
 * @module
 */

import { fromBase64Url } from "./base64url.ts";
import { JwtError } from "./errors.ts";

/** A JOSE header (RFC 7515 section 4.1); `alg` is always a string. */
export interface JwtHeader {
  readonly alg: string;
  readonly typ?: string;
  readonly cty?: string;
  readonly kid?: string;
  readonly crit?: readonly string[];
  readonly jku?: string;
  readonly x5u?: string;
  readonly x5t?: string;
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
export interface DecodedJwt<C extends JwtClaims = JwtClaims> {
  readonly header: JwtHeader;
  /** The claims as they are in the token; nothing about them is checked. */
  readonly payload: C;
  readonly signature: Uint8Array<ArrayBuffer>;
  /** `header.payload` as ASCII bytes: what the signature covers. */
  readonly signingInput: Uint8Array<ArrayBuffer>;
}

const decoder = new TextDecoder("utf-8", { fatal: true });
const encoder = new TextEncoder();

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function json(part: string, what: string): Record<string, unknown> {
  const bytes = fromBase64Url(part);
  if (bytes === null) {
    throw new JwtError("malformed", `the ${what} is not base64url`);
  }
  let value: unknown;
  try {
    value = JSON.parse(decoder.decode(bytes));
  } catch (cause) {
    throw new JwtError("malformed", `the ${what} is not JSON`, { cause });
  }
  if (!isObject(value)) {
    throw new JwtError("malformed", `the ${what} is not a JSON object`);
  }
  return value;
}

/**
 * Decodes a compact JWS whose payload is a JSON object, without verifying
 * anything; throws a `malformed` {@link JwtError} otherwise. The header must
 * have a string `alg`, and `crit`, when present, must be a non-empty list of
 * strings. Nothing it returns is trustworthy until `verify` has checked it.
 */
export function decode<C extends JwtClaims = JwtClaims>(
  token: string,
): DecodedJwt<C> {
  const parts = token.split(".");
  if (parts.length !== 3) {
    throw new JwtError("malformed", "a compact JWS has three parts");
  }
  const header = json(parts[0], "header");
  if (typeof header.alg !== "string") {
    throw new JwtError("malformed", "the header has no alg");
  }
  const crit = header.crit;
  if (
    crit !== undefined &&
    (!Array.isArray(crit) || crit.length === 0 ||
      !crit.every((name) => typeof name === "string"))
  ) {
    throw new JwtError("malformed", "crit must be a non-empty list of names");
  }
  const payload = json(parts[1], "payload");
  const signature = fromBase64Url(parts[2]);
  if (signature === null) {
    throw new JwtError("malformed", "the signature is not base64url");
  }
  return {
    header: header as JwtHeader,
    payload: payload as C,
    signature,
    signingInput: encoder.encode(`${parts[0]}.${parts[1]}`),
  };
}

/** {@link decode}, or null instead of a throw. */
export function tryDecode<C extends JwtClaims = JwtClaims>(
  token: string,
): DecodedJwt<C> | null {
  try {
    return decode<C>(token);
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

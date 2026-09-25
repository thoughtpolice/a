// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * The authorization server's tokens:
 *
 * - access tokens are JWTs in the RFC 9068 profile (`typ: at+jwt`, `iss`,
 *   `exp`, `aud`, `sub`, `client_id`, `iat`, `jti`, `scope`), signed with
 *   the first of the server's {@link SigningKey}s, with `cnf.jkt` when
 *   DPoP-bound (RFC 9449 section 6.1);
 * - refresh tokens are `<family>.<secret>`: the family names a stored
 *   record, which holds only hashes of the tokens.
 *
 * @module
 */

import {
  generateKeyPair,
  importKey,
  type Jwk,
  type Jwks,
  type JwsAlgorithm,
  type KeyLike,
  localJwks,
  publicJwk,
  sign,
  verify,
} from "@celld/jwt";
import {
  type Clock,
  formatScope,
  randomToken,
  rethrowRuntimeUnsupported,
} from "../util.ts";

/** A key the server signs access tokens with. */
export interface SigningKey {
  readonly alg: JwsAlgorithm;
  readonly kid: string;
  readonly privateKey: KeyLike;
  /** Published in the JWKS. */
  readonly publicJwk: Jwk;
}

/** A new signing key: ES256 unless `alg` says otherwise, with a random `kid` by default. */
export async function generateSigningKey(
  alg: JwsAlgorithm = "ES256",
  kid: string = randomToken(8),
): Promise<SigningKey> {
  const pair = await generateKeyPair(alg, { kid });
  return {
    alg,
    kid,
    privateKey: pair.privateKey,
    publicJwk: { ...pair.publicJwk, use: "sig" },
  };
}

/** A signing key from a private JWK (with `kid`), for keys kept in secrets. */
export async function signingKeyFromJwk(
  jwk: Jwk,
  alg: JwsAlgorithm,
): Promise<SigningKey> {
  if (jwk.kid === undefined) throw new TypeError("a signing JWK needs a kid");
  const privateKey = await importKey(jwk, alg, "sign");
  const { key_ops: _ops, ext: _ext, ...rest } = publicJwk(jwk);
  const publicJwkValue: Jwk = { ...rest, kid: jwk.kid, alg, use: "sig" };
  return { alg, kid: jwk.kid, privateKey, publicJwk: publicJwkValue };
}

/** The JWKS of a server's keys. */
export function publicJwks(keys: readonly SigningKey[]): Jwks {
  return {
    keys: keys.map((key) => ({ ...key.publicJwk, kid: key.kid, alg: key.alg })),
  };
}

/** What an access token asserts. */
export interface AccessTokenGrant {
  readonly subject: string;
  readonly clientId: string;
  readonly scope: readonly string[];
  /** RFC 8707 resources: the `aud`. */
  readonly audience: readonly string[];
  /** DPoP key thumbprint, for a bound token. */
  readonly jkt?: string;
  /** Epoch seconds the user authenticated. */
  readonly authTime?: number;
  /** RFC 8693 section 4.1: the acting party. */
  readonly act?: Readonly<Record<string, unknown>>;
  /** More claims; they cannot replace the registered ones. */
  readonly claims?: Readonly<Record<string, unknown>>;
}

const RESERVED = new Set([
  "iss",
  "sub",
  "aud",
  "exp",
  "nbf",
  "iat",
  "jti",
  "client_id",
  "scope",
  "cnf",
  "auth_time",
  "act",
]);

/** Signs an RFC 9068 access token; returns it with its `jti` and expiry (epoch seconds). */
export async function issueAccessToken(
  key: SigningKey,
  issuer: string,
  grant: AccessTokenGrant,
  lifetimeSec: number,
  now: Clock,
): Promise<{ token: string; jti: string; exp: number }> {
  const iat = Math.floor(now() / 1000);
  const jti = randomToken(16);
  const extra: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(grant.claims ?? {})) {
    if (!RESERVED.has(name)) extra[name] = value;
  }
  const claims: Record<string, unknown> = {
    ...extra,
    iss: issuer,
    sub: grant.subject,
    aud: grant.audience.length === 1 ? grant.audience[0] : [...grant.audience],
    exp: iat + lifetimeSec,
    iat,
    jti,
    client_id: grant.clientId,
  };
  const scope = formatScope(grant.scope);
  if (scope !== "") claims.scope = scope;
  if (grant.authTime !== undefined) claims.auth_time = grant.authTime;
  if (grant.jkt !== undefined) claims.cnf = { jkt: grant.jkt };
  if (grant.act !== undefined) claims.act = grant.act;
  const token = await sign(claims, key.privateKey, {
    alg: key.alg,
    kid: key.kid,
    typ: "at+jwt",
  });
  return { token, jti, exp: iat + lifetimeSec };
}

/**
 * The claims of an access token this server issued, or null: its
 * signature under one of `keys`, `typ` `at+jwt`, `iss`, and not expired.
 * A runtime that cannot verify the keys' algorithm throws instead.
 */
export async function verifyOwnAccessToken(
  token: string,
  keys: readonly SigningKey[],
  issuer: string,
  now: Clock,
): Promise<Record<string, unknown> | null> {
  try {
    const { payload } = await verify(token, localJwks(publicJwks(keys)), {
      algorithms: [...new Set(keys.map((key) => key.alg))],
      typ: "at+jwt",
      issuer,
      requiredClaims: ["exp", "sub", "client_id", "jti"],
      now,
    });
    return payload;
  } catch (cause) {
    rethrowRuntimeUnsupported(cause);
    return null;
  }
}

/** A refresh token's family and whole value. */
export function newRefreshToken(family: string): string {
  return `${family}.${randomToken(32)}`;
}

/** The family a refresh token names, or null for a malformed one. */
export function refreshFamily(token: string): string | null {
  const match = /^([A-Za-z0-9_-]{16,64})\.[A-Za-z0-9_-]{43}$/.exec(token);
  return match === null ? null : match[1];
}

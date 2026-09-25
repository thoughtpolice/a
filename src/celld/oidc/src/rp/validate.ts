// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * {@link validateIdToken}: every check of OpenID Connect Core section
 * 3.1.3.7 (and 3.1.3.8, 3.3.2.10, 12.2), in an order that reports the
 * first failure precisely, as an {@link IdTokenError}.
 *
 * @module
 */

import type { Clock } from "@celld/oauth";
import {
  type Jwks,
  type JwsAlgorithm,
  JwtError,
  type KeySet,
  tryDecode,
  verify,
} from "@celld/jwt";
import type { IdTokenClaims } from "../claims.ts";
import { IdTokenError } from "../errors.ts";
import { tokenHash } from "../hash.ts";
import { audiences, defaultClock, rethrowRuntimeUnsupported } from "../util.ts";

/**
 * What an ID token is accepted with by default: RS256 (the OpenID Connect
 * default) and the other asymmetric algorithms celld can verify. HMAC is
 * never accepted (it would make the client secret a signing key), and
 * neither is `none`.
 */
export const DEFAULT_ID_TOKEN_ALGORITHMS: readonly JwsAlgorithm[] = [
  "RS256",
  "ES256",
  "PS256",
  "ES384",
  "ES512",
  "RS384",
  "RS512",
  "PS384",
  "PS512",
];

/** What an ID token is checked against. */
export interface IdTokenValidationOptions {
  /** The provider's issuer identifier: `iss` must be exactly this. */
  readonly issuer: string;
  /** This client's id: `aud` must name it. */
  readonly clientId: string;
  /** The provider's keys; a `RemoteJwks` on `jwks_uri` follows key rotation. */
  readonly keys: KeySet | Jwks;
  /**
   * Accepted `alg`s; default {@link DEFAULT_ID_TOKEN_ALGORITHMS}, or the
   * one the client registered as `id_token_signed_response_alg`. HMAC and
   * `none` are refused whatever this says.
   */
  readonly algorithms?: readonly JwsAlgorithm[];
  /** The `nonce` sent in the request: the token must carry it. */
  readonly nonce?: string;
  /** Tokens that carry a `nonce` are refused (a refresh's ID token must not have one); default false. */
  readonly forbidNonce?: boolean;
  /** The request's `max_age` (seconds): `auth_time` is required and must be recent enough. */
  readonly maxAge?: number;
  /** Require `auth_time` even without `max_age` (it was requested as a claim). */
  readonly requireAuthTime?: boolean;
  /** For a refreshed ID token: `auth_time` must equal the original's. */
  readonly authTime?: number;
  /** For a refreshed ID token or a UserInfo answer: `sub` must be this. */
  readonly subject?: string;
  /** The access token from the same response: a present `at_hash` must match it. */
  readonly accessToken?: string;
  /** Refuse a token without `at_hash` when `accessToken` is given; default false. */
  readonly requireAtHash?: boolean;
  /** The authorization code: a present `c_hash` must match it. */
  readonly code?: string;
  /** Acceptable `acr` values: when set, `acr` must be one of them. */
  readonly acrValues?: readonly string[];
  /** Audiences besides the client that may appear in `aud`; default none. */
  readonly trustedAudiences?: readonly string[];
  /** Seconds of clock skew for `exp`, `iat` and `auth_time`; default 30. */
  readonly clockToleranceSec?: number;
  /** The oldest `iat` accepted, in seconds; default 600. */
  readonly maxIatAgeSec?: number;
  readonly now?: Clock;
}

const JWT_CODES: Readonly<Partial<Record<string, IdTokenError["code"]>>> = {
  malformed: "malformed",
  unsupported_alg: "alg",
  alg_not_allowed: "alg",
  crit: "malformed",
  key_mismatch: "signature",
  no_key: "signature",
  bad_signature: "signature",
  jwks: "keys",
  expired: "exp",
  not_yet_valid: "iat",
  too_old: "iat",
  missing_claim: "claims",
  invalid_claim: "claims",
};

/**
 * Validates an ID token and returns its claims; see the module
 * documentation. The checks, in order: it decodes; `alg` is allowed (and
 * never HMAC or `none`); the signature verifies with the issuer's keys;
 * `iss`, `sub`, `aud`, `exp` and `iat` are present and well typed; `exp`
 * is in the future and `iat` is neither in the future nor older than
 * `maxIatAgeSec` (within the clock tolerance); `iss` is exactly the
 * issuer; `aud` names the client and no untrusted audience; `azp`, when
 * present or when there are several audiences, is the client; `nonce`;
 * `auth_time` against `max_age` (or the original on refresh); `acr`;
 * `at_hash` and `c_hash`; and `sub` when one is expected.
 */
export async function validateIdToken(
  token: string,
  options: IdTokenValidationOptions,
): Promise<IdTokenClaims> {
  const now = options.now ?? defaultClock;
  const tolerance = options.clockToleranceSec ?? 30;
  const decoded = tryDecode(token);
  if (decoded === null) {
    throw new IdTokenError("malformed", "the ID token is not a compact JWS");
  }
  const algorithms = (options.algorithms ?? DEFAULT_ID_TOKEN_ALGORITHMS)
    .filter((alg) => !alg.startsWith("HS"));
  const alg = decoded.header.alg;
  if (!(algorithms as readonly string[]).includes(alg)) {
    throw new IdTokenError(
      "alg",
      `the ID token is signed with ${
        JSON.stringify(alg)
      }, which is not accepted`,
    );
  }
  let claims: Record<string, unknown>;
  try {
    ({ payload: claims } = await verify(token, options.keys, {
      algorithms,
      requiredClaims: ["iss", "sub", "aud", "exp", "iat"],
      clockTolerance: tolerance,
      maxTokenAge: options.maxIatAgeSec ?? 600,
      now,
    }));
  } catch (cause) {
    rethrowRuntimeUnsupported(cause);
    if (cause instanceof JwtError) {
      throw new IdTokenError(
        JWT_CODES[cause.code] ?? "malformed",
        `the ID token is refused: ${cause.message}`,
        { cause },
      );
    }
    throw cause;
  }
  if (claims.iss !== options.issuer) {
    throw new IdTokenError(
      "iss",
      `the ID token is from ${
        JSON.stringify(claims.iss)
      }, not ${options.issuer}`,
    );
  }
  const aud = audiences(claims.aud);
  if (!aud.includes(options.clientId)) {
    throw new IdTokenError("aud", "the ID token is not for this client");
  }
  const trusted = new Set([
    options.clientId,
    ...(options.trustedAudiences ?? []),
  ]);
  if (aud.some((item) => !trusted.has(item))) {
    throw new IdTokenError("aud", "the ID token names an untrusted audience");
  }
  if (claims.azp !== undefined || aud.length > 1) {
    if (claims.azp !== options.clientId) {
      throw new IdTokenError(
        "azp",
        claims.azp === undefined
          ? "an ID token with several audiences must name its authorized party"
          : "the ID token was issued to another party (azp)",
      );
    }
  }
  if (options.nonce !== undefined) {
    if (typeof claims.nonce !== "string" || claims.nonce !== options.nonce) {
      throw new IdTokenError(
        "nonce",
        claims.nonce === undefined
          ? "the ID token has no nonce"
          : "the ID token's nonce is not the one sent",
      );
    }
  } else if (options.forbidNonce && claims.nonce !== undefined) {
    throw new IdTokenError("nonce", "this ID token must not carry a nonce");
  }
  const authTime = claims.auth_time;
  if (authTime !== undefined && typeof authTime !== "number") {
    throw new IdTokenError("claims", "auth_time must be a number");
  }
  const clock = now() / 1000;
  if (
    options.maxAge !== undefined || options.requireAuthTime ||
    options.authTime !== undefined
  ) {
    if (authTime === undefined) {
      throw new IdTokenError("auth_time", "the ID token has no auth_time");
    }
  }
  if (authTime !== undefined) {
    if (authTime > clock + tolerance) {
      throw new IdTokenError("auth_time", "auth_time is in the future");
    }
    if (
      options.maxAge !== undefined &&
      clock - authTime > options.maxAge + tolerance
    ) {
      throw new IdTokenError(
        "auth_time",
        `the user authenticated more than max_age (${options.maxAge} s) ago`,
      );
    }
    if (options.authTime !== undefined && authTime !== options.authTime) {
      throw new IdTokenError(
        "auth_time",
        "auth_time differs from the original ID token's",
      );
    }
  }
  if (options.acrValues !== undefined && options.acrValues.length > 0) {
    if (
      typeof claims.acr !== "string" || !options.acrValues.includes(claims.acr)
    ) {
      throw new IdTokenError(
        "acr",
        `the authentication (acr ${
          JSON.stringify(claims.acr)
        }) is not one asked for`,
      );
    }
  }
  if (options.accessToken !== undefined) {
    if (claims.at_hash === undefined) {
      if (options.requireAtHash) {
        throw new IdTokenError("at_hash", "the ID token has no at_hash");
      }
    } else if (claims.at_hash !== await tokenHash(options.accessToken, alg)) {
      throw new IdTokenError(
        "at_hash",
        "at_hash does not match the access token",
      );
    }
  }
  if (options.code !== undefined && claims.c_hash !== undefined) {
    if (claims.c_hash !== await tokenHash(options.code, alg)) {
      throw new IdTokenError("c_hash", "c_hash does not match the code");
    }
  }
  if (options.subject !== undefined && claims.sub !== options.subject) {
    throw new IdTokenError("sub", "the ID token is about another subject");
  }
  if (typeof claims.sub !== "string" || claims.sub === "") {
    throw new IdTokenError("claims", "sub must be a non-empty string");
  }
  return claims as IdTokenClaims;
}

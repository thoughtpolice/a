// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * {@link jwtBearer}: bearer JWT access tokens verified with `@celld/jwt`,
 * and {@link jwtVerifier}, the same check as a {@link TokenVerifier}.
 *
 * @module
 */

import {
  type JwsAlgorithm,
  type JwtClaims,
  JwtError,
  type JwtErrorCode,
  type Now,
  verify,
  type VerifyKey,
} from "@celld/jwt";
import {
  AuthError,
  type AuthScheme,
  type ChallengeOptions,
  type PrincipalInput,
} from "./auth.ts";
import { bearer, type TokenVerifier } from "./bearer.ts";
import { HttpError, RouterError } from "./errors.ts";

/** What a JWT access token must be. */
export interface JwtVerifierOptions {
  /**
   * The keys: a JWK, a JWKS, a `CryptoKey`, an HMAC secret, or a key set
   * such as `new RemoteJwks(jwksUri)`.
   */
  readonly keys: VerifyKey;
  /** `iss` must be this (or one of these). */
  readonly issuer: string | readonly string[];
  /** `aud` must name this (or one of these): a token for another API is refused. */
  readonly audience: string | readonly string[];
  /** The accepted `alg`s; there is no default, so the list is always a decision. */
  readonly algorithms: readonly JwsAlgorithm[];
  /** Accepted `typ` values, such as `at+jwt` (RFC 9068). */
  readonly typ?: string | readonly string[];
  /** Seconds of clock skew allowed; default 0. */
  readonly clockTolerance?: number;
  /** Claims required beyond `sub` and `exp`, which always are. */
  readonly requiredClaims?: readonly string[];
  readonly maxTokenAge?: number;
  readonly now?: Now;
  /**
   * Maps verified claims to a principal (or null to refuse). The default
   * takes `sub`; scopes from `scope` (space-separated) or `scp` (a list or
   * a string); roles from `roles`; `client_id` (or `azp`); `tid` (or
   * `tenant`); and `cnf.jkt`.
   */
  readonly principal?: (claims: JwtClaims) => PrincipalInput | null;
}

function strings(value: unknown): string[] {
  if (typeof value === "string") {
    return value.split(" ").filter((s) => s !== "");
  }
  if (Array.isArray(value)) return value.filter((s) => typeof s === "string");
  return [];
}

function text(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

/** The default claims-to-principal mapping; see {@link JwtVerifierOptions.principal}. */
export function principalFromClaims(claims: JwtClaims): PrincipalInput | null {
  if (typeof claims.sub !== "string" || claims.sub === "") return null;
  const scopes = claims.scope !== undefined
    ? strings(claims.scope)
    : strings(claims.scp);
  const cnf = claims.cnf as { jkt?: unknown } | undefined;
  const jkt = typeof cnf === "object" && cnf !== null
    ? text(cnf.jkt)
    : undefined;
  const clientId = text(claims.client_id) ?? text(claims.azp);
  const tenant = text(claims.tid) ?? text(claims.tenant);
  return {
    subject: claims.sub,
    scopes,
    roles: strings(claims.roles),
    claims,
    ...(clientId === undefined ? {} : { clientId }),
    ...(tenant === undefined ? {} : { tenant }),
    ...(jkt === undefined ? {} : { cnf: { jkt } }),
  };
}

const DESCRIPTIONS: Partial<Record<JwtErrorCode, string>> = {
  expired: "the access token expired",
  not_yet_valid: "the access token is not valid yet",
  too_old: "the access token is too old",
  issuer: "the access token is from another issuer",
  audience: "the access token is for another audience",
  alg_not_allowed: "the access token's algorithm is not accepted",
  unsupported_alg: "the access token's algorithm is not accepted",
  typ: "the access token has the wrong type",
  missing_claim: "the access token lacks a required claim",
};

/**
 * A {@link TokenVerifier} for JWT access tokens: signature, `alg` from
 * `algorithms`, `iss`, `aud`, `exp` (required), `nbf`, `sub` (required)
 * and `typ`. A failure is `invalid_token` with a short description (never
 * the token's contents); a key set that cannot be fetched is a 503, and an
 * accepted algorithm the runtime cannot verify (`runtime_unsupported`) is
 * thrown, so it is a 500 that reaches `onError`.
 */
export function jwtVerifier(options: JwtVerifierOptions): TokenVerifier {
  if (options.algorithms.length === 0) {
    throw new RouterError("jwtVerifier needs at least one algorithm");
  }
  const toPrincipal = options.principal ?? principalFromClaims;
  const required = ["sub", "exp", ...(options.requiredClaims ?? [])];
  return async ({ token }) => {
    let claims: JwtClaims;
    try {
      ({ payload: claims } = await verify(token, options.keys, {
        algorithms: options.algorithms,
        issuer: options.issuer,
        audience: options.audience,
        typ: options.typ,
        clockTolerance: options.clockTolerance,
        requiredClaims: required,
        maxTokenAge: options.maxTokenAge,
        now: options.now,
      }));
    } catch (error) {
      // A token this runtime cannot check (celld cannot verify Ed25519)
      // is the server's problem, not the client's: a reported 500.
      if (
        !(error instanceof JwtError) || error.code === "runtime_unsupported"
      ) {
        throw error;
      }
      if (error.code === "jwks") {
        throw new HttpError(503, "the token signing keys are unavailable", {
          cause: error,
        });
      }
      return new AuthError(
        "invalid_token",
        DESCRIPTIONS[error.code] ?? "the access token is not valid",
      );
    }
    return toPrincipal(claims);
  };
}

/**
 * Options for {@link jwtBearer}: the token rules and the bearer scheme's,
 * including the challenges' `realm` and `resourceMetadata` (RFC 9728).
 */
export interface JwtBearerOptions extends JwtVerifierOptions, ChallengeOptions {
  readonly allowQuery?: boolean;
  readonly name?: string;
}

/**
 * Bearer JWT access tokens: {@link bearer} with {@link jwtVerifier}.
 *
 * ```ts
 * jwtBearer({
 *   keys: new RemoteJwks("https://auth.example.com/.well-known/jwks.json"),
 *   issuer: "https://auth.example.com",
 *   audience: "https://api.example.com",
 *   algorithms: ["ES256", "RS256"],
 *   typ: "at+jwt",
 * })
 * ```
 */
export function jwtBearer(options: JwtBearerOptions): AuthScheme {
  return bearer({
    verify: jwtVerifier(options),
    realm: options.realm,
    resourceMetadata: options.resourceMetadata,
    allowQuery: options.allowQuery,
    name: options.name,
    bearerFormat: "JWT",
  });
}

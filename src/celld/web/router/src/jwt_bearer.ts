// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * {@link jwtBearer}: bearer JWT access tokens verified with `@celld/sec/jwt`,
 * and {@link jwtVerifier}, the same check as a {@link TokenVerifier}.
 *
 * @module
 */

import {
  createVerifier,
  type JwsAlgorithm,
  type JwtClaims,
  JwtError,
  type JwtErrorCode,
  type Now,
  type VerifyKey,
} from "@celld/sec/jwt";
import {
  AuthError,
  type AuthScheme,
  type ChallengeOptions,
  type PrincipalInput,
} from "./auth.ts";
import { bearer, type TokenVerifier } from "./bearer.ts";
import { deepFreeze } from "./compile.ts";
import { HttpError, RouterError } from "./errors.ts";
import { optionsRecord, optionType, tokenList } from "./validation.ts";

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
  /** Accepted `typ` values; default `at+jwt` (RFC 9068). */
  readonly typ?: string | readonly string[];
  /**
   * Accept a JWT without checking its `typ`. This is only for legacy issuers
   * that cannot explicitly type access tokens. It also permits another JWT
   * kind with otherwise matching claims, so prefer `typ` (default `at+jwt`).
   */
  readonly unsafeAllowAnyTokenType?: boolean;
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
   * `tenant`); `iss` as `issuer`; `exp` as `expiresAt` (milliseconds); and
   * `cnf.jkt`.
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
  if (
    claims.cnf !== undefined &&
    (typeof cnf !== "object" || cnf === null || Array.isArray(cnf) ||
      typeof cnf.jkt !== "string" || !/^[A-Za-z0-9_-]{1,256}$/.test(cnf.jkt))
  ) return null;
  const jkt = typeof cnf === "object" && cnf !== null
    ? text(cnf.jkt)
    : undefined;
  const clientId = text(claims.client_id) ?? text(claims.azp);
  const tenant = text(claims.tid) ?? text(claims.tenant);
  const issuer = text(claims.iss);
  const exp = claims.exp;
  const expiresAt = typeof exp === "number" && Number.isFinite(exp)
    ? exp * 1000
    : undefined;
  return {
    subject: claims.sub,
    scopes,
    roles: strings(claims.roles),
    claims,
    ...(clientId === undefined ? {} : { clientId }),
    ...(tenant === undefined ? {} : { tenant }),
    ...(issuer === undefined ? {} : { issuer }),
    ...(expiresAt === undefined ? {} : { expiresAt }),
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
 * `keys` as they are now: a secret's bytes and plain JWK or JWKS data are
 * copied and frozen, so adding a key to the caller's set afterwards trusts
 * nothing new. Key objects (`RemoteJwks`, `localJwks`, a `CryptoKey`) are
 * used as they are; they own their contents.
 */
function snapshotKeys(keys: VerifyKey): VerifyKey {
  if (keys instanceof Uint8Array) return keys.slice();
  if (typeof keys !== "object" || keys === null) return keys;
  const proto = Object.getPrototypeOf(keys);
  if (proto !== Object.prototype && proto !== null) return keys;
  if (typeof (keys as { resolve?: unknown }).resolve === "function") {
    return keys;
  }
  return deepFreeze(structuredClone(keys));
}

/**
 * A {@link TokenVerifier} for JWT access tokens: signature, `alg` from
 * `algorithms`, `iss`, `aud`, `exp` (required), `nbf`, `sub` (required)
 * and `typ` (`at+jwt` by default). A failure is `invalid_token` with a short
 * description (never the token's contents); a key set that cannot be fetched
 * is a 503, and an accepted algorithm the runtime cannot verify
 * (`runtime_unsupported`) is a 503 that reaches `onError`, without an
 * invalid-token challenge. Await the verifier's `ready()` before serving to
 * detect it at startup. A legacy issuer that cannot type access tokens needs
 * the explicit `unsafeAllowAnyTokenType: true` opt-out.
 */
export function jwtVerifier(options: JwtVerifierOptions): TokenVerifier {
  optionsRecord(options, [
    "keys",
    "issuer",
    "audience",
    "algorithms",
    "typ",
    "unsafeAllowAnyTokenType",
    "clockTolerance",
    "requiredClaims",
    "maxTokenAge",
    "now",
    "principal",
  ], "jwtVerifier options");
  optionType(options.principal, "function", "jwtVerifier principal");
  optionType(
    options.unsafeAllowAnyTokenType,
    "boolean",
    "jwtVerifier unsafeAllowAnyTokenType",
  );
  if (options.unsafeAllowAnyTokenType === true && options.typ !== undefined) {
    throw new RouterError(
      "jwtVerifier cannot take typ with unsafeAllowAnyTokenType",
    );
  }
  tokenList(options.requiredClaims, "requiredClaims");
  if (!Array.isArray(options.algorithms) || options.algorithms.length === 0) {
    throw new RouterError("jwtVerifier needs at least one algorithm");
  }
  // `@celld/sec/jwt` skips the `iss`/`aud` checks when they are not given, so a
  // caller whose types did not stop it (JavaScript, a cast) would accept
  // tokens from anyone for anything.
  for (const what of ["issuer", "audience"] as const) {
    const value: unknown = options[what];
    const list = typeof value === "string"
      ? [value]
      : Array.isArray(value)
      ? value
      : null;
    if (
      list === null || list.length === 0 ||
      !list.every((item) => typeof item === "string" && item !== "")
    ) {
      throw new RouterError(
        `jwtVerifier needs an ${what}: a non-empty string or list of them`,
      );
    }
  }
  const toPrincipal = options.principal ?? principalFromClaims;
  const required = Object.freeze([
    "sub",
    "exp",
    ...(options.requiredClaims ?? []),
  ]);
  const copy = <T>(value: T | readonly T[] | undefined) =>
    Array.isArray(value) ? Object.freeze([...value]) as readonly T[] : value;
  // Read once: changing `options` afterwards changes nothing.
  const checks = Object.freeze({
    algorithms: Object.freeze([...options.algorithms]),
    issuer: copy(options.issuer),
    audience: copy(options.audience),
    typ: options.unsafeAllowAnyTokenType === true
      ? undefined
      : copy(options.typ ?? "at+jwt"),
    clockTolerance: options.clockTolerance,
    requiredClaims: required,
    maxTokenAge: options.maxTokenAge,
    now: options.now,
  });
  const keys = snapshotKeys(options.keys);
  const prepared = createVerifier({ keys, ...checks });
  const verifier: TokenVerifier = async ({ token }) => {
    let claims: JwtClaims;
    try {
      ({ payload: claims } = await prepared.verify(token));
    } catch (error) {
      // Runtime capability is server availability, never token validity.
      if (!(error instanceof JwtError)) {
        throw error;
      }
      if (error.code === "jwks" || error.code === "runtime_unsupported") {
        throw new HttpError(503, "token verification is unavailable", {
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
  return Object.assign(verifier, { ready: () => prepared.ready() });
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
 * })
 * ```
 *
 * Like the underlying {@link jwtVerifier}, this access-token scheme requires
 * `typ: "at+jwt"` by default, preventing an ID token signed by the same issuer
 * from being used as an API credential. Set `typ` to another explicit
 * access-token media type when required. A legacy issuer that sends no
 * reliable `typ` needs the conspicuous `unsafeAllowAnyTokenType: true` opt-out.
 */
export function jwtBearer(options: JwtBearerOptions): AuthScheme {
  optionsRecord(options, [
    "keys",
    "issuer",
    "audience",
    "algorithms",
    "typ",
    "clockTolerance",
    "requiredClaims",
    "maxTokenAge",
    "now",
    "principal",
    "unsafeAllowAnyTokenType",
    "allowQuery",
    "name",
    "realm",
    "resourceMetadata",
  ], "jwtBearer options");
  const {
    allowQuery,
    name,
    realm,
    resourceMetadata,
    ...verification
  } = options;
  return bearer({
    verify: jwtVerifier(verification),
    realm,
    resourceMetadata,
    allowQuery,
    name,
    bearerFormat: "JWT",
  });
}

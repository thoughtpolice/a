// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * Access token verifiers: what turns a token into a {@link VerifiedToken}
 * for a resource server.
 *
 * - {@link jwtAccessTokenVerifier}: JWT access tokens in the RFC 9068
 *   profile, checked locally against the issuer's keys.
 * - {@link introspectionVerifier}: asks the authorization server
 *   (RFC 7662), caching active answers briefly.
 *
 * Both refuse a token by throwing a {@link ProtocolError}: `invalid_token`
 * (401) for a bad token, `temporarily_unavailable` (503) when the answer
 * could not be had. A runtime that cannot verify the token's algorithm at
 * all (`@celld/jwt`'s `runtime_unsupported`) is rethrown as it is, since
 * that is the server's fault, not the token's. Anything else can implement
 * {@link AccessTokenVerifier}.
 *
 * @module
 */

import {
  type Jwks,
  type JwsAlgorithm,
  JwtError,
  type KeySet,
  localJwks,
  RemoteJwks,
  verify,
} from "@celld/jwt";
import type { ClientAuthentication } from "../client/auth.ts";
import { applyClientAuthentication } from "../client/auth.ts";
import { ProtocolError } from "../errors.ts";
import { checkSecureUrl } from "../metadata.ts";
import {
  type Clock,
  defaultClock,
  defaultFetch,
  type FetchLike,
  isObject,
  parseScope,
  readJsonObject,
  rethrowRuntimeUnsupported,
  sha256,
} from "../util.ts";

/** What a valid access token says. */
export interface VerifiedToken {
  /** `sub`, or the client id for a token without one. */
  readonly subject: string;
  readonly scopes: readonly string[];
  readonly clientId?: string;
  readonly issuer?: string;
  /** Every audience the token names. */
  readonly audience: readonly string[];
  /** Epoch milliseconds. */
  readonly expiresAt?: number;
  /** The confirmation claim (RFC 7800); `jkt` for a DPoP-bound token. */
  readonly cnf?: { readonly jkt?: string; readonly [key: string]: unknown };
  /** The token's claims (or the introspection answer); never the token. */
  readonly claims: Readonly<Record<string, unknown>>;
}

/** Checks access tokens. */
export interface AccessTokenVerifier {
  /**
   * The token's facts; throws a {@link ProtocolError} (`invalid_token`,
   * or 503 `temporarily_unavailable`) to refuse it.
   */
  verify(token: string): Promise<VerifiedToken>;
}

function invalidToken(description: string, cause?: unknown): ProtocolError {
  return new ProtocolError("invalid_token", {
    status: 401,
    description,
    cause,
  });
}

/** Scopes from a `scope` string or an `scp` array. */
export function scopesOf(claims: Readonly<Record<string, unknown>>): string[] {
  if (typeof claims.scope === "string") return parseScope(claims.scope);
  if (Array.isArray(claims.scp)) {
    return claims.scp.filter((scope): scope is string =>
      typeof scope === "string"
    );
  }
  return [];
}

function audiences(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) {
    return value.filter((item): item is string => typeof item === "string");
  }
  return [];
}

function confirmation(
  value: unknown,
): VerifiedToken["cnf"] | undefined {
  if (!isObject(value)) return undefined;
  if (value.jkt !== undefined && typeof value.jkt !== "string") {
    throw invalidToken("cnf.jkt must be a string");
  }
  return value as VerifiedToken["cnf"];
}

/**
 * The asymmetric algorithms accepted by default. A resource server does
 * not share a secret with the issuer, so HMAC is left out.
 */
export const DEFAULT_ACCESS_TOKEN_ALGORITHMS: readonly JwsAlgorithm[] = [
  "RS256",
  "RS384",
  "RS512",
  "PS256",
  "PS384",
  "PS512",
  "ES256",
  "ES384",
  "ES512",
];

/** Options for {@link jwtAccessTokenVerifier}. */
export interface JwtAccessTokenVerifierOptions {
  /** The expected `iss`, exactly (or one of these). */
  readonly issuer: string | readonly string[];
  /** This resource's identifier(s); the token's `aud` must name one. */
  readonly audience: string | readonly string[];
  /** The issuer's keys: a JWKS URL, a JWKS, or any `KeySet`. */
  readonly keys: string | Jwks | KeySet;
  /** Default {@link DEFAULT_ACCESS_TOKEN_ALGORITHMS}. */
  readonly algorithms?: readonly JwsAlgorithm[];
  /**
   * RFC 9068 strictly (the default): `typ` must be `at+jwt`, and `iss`,
   * `exp`, `aud`, `sub`, `client_id`, `iat` and `jti` are required.
   * False accepts any JWT with `iss`, `aud` and `exp`, for issuers that
   * predate the profile.
   */
  readonly strict?: boolean;
  /** Seconds of clock skew for `exp`, `nbf` and `iat`; default 30. */
  readonly clockToleranceSec?: number;
  readonly fetch?: FetchLike;
  readonly now?: Clock;
}

/**
 * A verifier for JWT access tokens (RFC 9068): the signature against the
 * issuer's keys (remote keys are cached and refetched for unknown `kid`s,
 * see `RemoteJwks`), `typ`, `iss`, `aud` naming this resource (RFC 8707:
 * a token for anything else is refused), `exp`, `nbf`, and the required
 * claims.
 */
export function jwtAccessTokenVerifier(
  options: JwtAccessTokenVerifierOptions,
): AccessTokenVerifier {
  const now = options.now ?? defaultClock;
  let keys: KeySet;
  if (typeof options.keys === "string") {
    checkSecureUrl(options.keys, "jwks_uri");
    keys = new RemoteJwks(options.keys, {
      fetch: options.fetch,
      now,
      allowInsecure: true,
    });
  } else if (Array.isArray((options.keys as Jwks).keys)) {
    keys = localJwks(options.keys as Jwks);
  } else {
    keys = options.keys as KeySet;
  }
  const strict = options.strict ?? true;
  return {
    async verify(token) {
      let claims: Record<string, unknown>;
      try {
        ({ payload: claims } = await verify(token, keys, {
          algorithms: options.algorithms ?? DEFAULT_ACCESS_TOKEN_ALGORITHMS,
          typ: strict ? "at+jwt" : undefined,
          issuer: options.issuer,
          audience: options.audience,
          clockTolerance: options.clockToleranceSec ?? 30,
          requiredClaims: strict
            ? ["iss", "exp", "aud", "sub", "client_id", "iat", "jti"]
            : ["exp"],
          now,
        }));
      } catch (cause) {
        rethrowRuntimeUnsupported(cause);
        if (cause instanceof JwtError && cause.code === "jwks") {
          throw new ProtocolError("temporarily_unavailable", {
            status: 503,
            description: "the issuer's keys are unavailable",
            cause,
          });
        }
        throw invalidToken(
          cause instanceof JwtError ? cause.message : "the token is invalid",
          cause,
        );
      }
      const clientId = typeof claims.client_id === "string"
        ? claims.client_id
        : typeof claims.azp === "string"
        ? claims.azp
        : undefined;
      if (strict && typeof claims.client_id !== "string") {
        throw invalidToken("client_id must be a string");
      }
      const subject = typeof claims.sub === "string" ? claims.sub : clientId;
      if (subject === undefined) throw invalidToken("the token has no subject");
      return {
        subject,
        scopes: scopesOf(claims),
        clientId,
        issuer: claims.iss as string,
        audience: audiences(claims.aud),
        expiresAt: (claims.exp as number) * 1000,
        cnf: confirmation(claims.cnf),
        claims,
      };
    },
  };
}

/** Options for {@link introspectionVerifier}. */
export interface IntrospectionVerifierOptions {
  /** The authorization server's `introspection_endpoint`. */
  readonly endpoint: string;
  /** The issuer, for client assertions and to check an answer's `iss`. */
  readonly issuer: string;
  /** This resource server's own client authentication. */
  readonly client: ClientAuthentication;
  /** This resource's identifier(s); the answer's `aud` must name one. */
  readonly audience: string | readonly string[];
  /**
   * Refuse answers without an `aud` naming this resource; default true.
   * RFC 7662 makes `aud` optional, but a resource must know a token was
   * issued for it.
   */
  readonly requireAudience?: boolean;
  /** How long an active answer is reused (capped at its `exp`); default 60 s, 0 never. */
  readonly cacheMs?: number;
  /** The most answers cached; default 10000. */
  readonly maxEntries?: number;
  readonly fetch?: FetchLike;
  readonly now?: Clock;
}

/**
 * A verifier that asks the authorization server (RFC 7662). An active
 * answer is refused when its `iss` is not the issuer, it names another
 * audience (or none, with `requireAudience`), or its `exp` or `nbf` say
 * the token is not valid now. Active answers are cached, keyed by the
 * token's hash, for `cacheMs` or until `exp`.
 */
export function introspectionVerifier(
  options: IntrospectionVerifierOptions,
): AccessTokenVerifier {
  checkSecureUrl(options.endpoint, "introspection_endpoint");
  const fetch = options.fetch ?? defaultFetch;
  const now = options.now ?? defaultClock;
  const expected = typeof options.audience === "string"
    ? [options.audience]
    : [...options.audience];
  const cacheMs = options.cacheMs ?? 60_000;
  const maxEntries = options.maxEntries ?? 10_000;
  const cache = new Map<string, { until: number; value: VerifiedToken }>();
  return {
    async verify(token) {
      const key = await sha256(token);
      const hit = cache.get(key);
      if (hit !== undefined && hit.until > now()) return hit.value;
      cache.delete(key);
      const applied = await applyClientAuthentication(
        options.client,
        options.issuer,
        options.endpoint,
        now,
      );
      const body = new URLSearchParams({
        ...applied.params,
        token,
        token_type_hint: "access_token",
      });
      let answer: Record<string, unknown> | null;
      try {
        const response = await fetch(options.endpoint, {
          method: "POST",
          headers: {
            "content-type": "application/x-www-form-urlencoded",
            accept: "application/json",
            ...applied.headers,
          },
          body: body.toString(),
        });
        answer = await readJsonObject(response);
        if (!response.ok) answer = null;
      } catch (cause) {
        throw new ProtocolError("temporarily_unavailable", {
          status: 503,
          description: "the introspection endpoint is unreachable",
          cause,
        });
      }
      if (answer === null || typeof answer.active !== "boolean") {
        throw new ProtocolError("temporarily_unavailable", {
          status: 503,
          description: "the introspection endpoint did not answer",
        });
      }
      if (answer.active !== true) throw invalidToken("the token is not active");
      if (answer.iss !== undefined && answer.iss !== options.issuer) {
        throw invalidToken("the token is from another issuer");
      }
      const aud = audiences(answer.aud);
      if (
        (aud.length > 0 || (options.requireAudience ?? true)) &&
        !aud.some((item) => expected.includes(item))
      ) {
        throw invalidToken("the token is not for this resource");
      }
      const clock = now();
      if (typeof answer.exp === "number" && answer.exp * 1000 <= clock) {
        throw invalidToken("the token has expired");
      }
      if (typeof answer.nbf === "number" && answer.nbf * 1000 > clock) {
        throw invalidToken("the token is not valid yet");
      }
      const clientId = typeof answer.client_id === "string"
        ? answer.client_id
        : undefined;
      const subject = typeof answer.sub === "string" ? answer.sub : clientId;
      if (subject === undefined) throw invalidToken("the token has no subject");
      const value: VerifiedToken = {
        subject,
        scopes: scopesOf(answer),
        clientId,
        issuer: options.issuer,
        audience: aud,
        expiresAt: typeof answer.exp === "number"
          ? answer.exp * 1000
          : undefined,
        cnf: confirmation(answer.cnf),
        claims: answer,
      };
      if (cacheMs > 0) {
        cache.set(key, {
          until: Math.min(clock + cacheMs, value.expiresAt ?? Infinity),
          value,
        });
        while (cache.size > maxEntries) {
          cache.delete(cache.keys().next().value!);
        }
      }
      return value;
    },
  };
}

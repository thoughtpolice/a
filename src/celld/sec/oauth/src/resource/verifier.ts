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
 * all (`@celld/sec/jwt`'s `runtime_unsupported`) is rethrown as it is, since
 * that is the server's fault, not the token's. Anything else can implement
 * {@link AccessTokenVerifier}.
 *
 * @module
 */

import { finite, safeInt, strictRecord } from "@celld/core/bounds";
import { EgressError, type EgressPolicy } from "@celld/http/egress";
import {
  assertAlgorithmsSupported,
  createVerifier,
  type Jwks,
  JwtError,
  type KeySet,
  localJwks,
  RemoteJwks,
} from "@celld/sec/jwt";
import type { ClientAuthentication } from "../client/auth.ts";
import {
  applyClientAuthentication,
  checkClientAuthentication,
} from "../client/auth.ts";
import { isIssuer } from "../metadata.ts";
import { type DpopAlgorithm, isDpopAlgorithm } from "../dpop/key.ts";
import { OutboundWork } from "../work.ts";
import {
  egressFetch,
  type EgressOptions,
  egressUrlProblem,
  endpointEgressPolicy,
} from "../egress.ts";
import { ProtocolError } from "../errors.ts";
import {
  type Clock,
  defaultClock,
  defaultFetch,
  type FetchLike,
  isObject,
  isScopeToken,
  parseScope,
  rethrowRuntimeUnsupported,
  sha256,
  snapshot,
  snapshotOptions,
} from "../util.ts";

/** What a valid access token says. */
export interface VerifiedToken {
  /** `sub`, or the client id for a token without one. */
  readonly subject: string;
  readonly scopes: readonly string[];
  readonly clientId?: string;
  /**
   * The token's issuer. A resource server with several authorization
   * servers requires it (and one of them); with one, it defaults to that.
   */
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
  /** Probe configured crypto/keys before serving. Custom verifiers may provide their own readiness check. */
  ready?(): Promise<void>;
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
  if (
    claims.scope !== undefined &&
    (typeof claims.scope !== "string" || claims.scope.length > 4096)
  ) {
    throw invalidToken("scope must be a bounded string");
  }
  if (claims.scp !== undefined && !Array.isArray(claims.scp)) {
    throw invalidToken("scp must be a scope array");
  }
  const scopes = typeof claims.scope === "string"
    ? parseScope(claims.scope)
    : claims.scp ?? [];
  if (
    !Array.isArray(scopes) || scopes.length > 256 ||
    scopes.some((scope) =>
      typeof scope !== "string" || scope.length > 256 || !isScopeToken(scope)
    )
  ) {
    throw invalidToken("scope contains invalid or oversized tokens");
  }
  return [...scopes] as string[];
}

function audiences(value: unknown): string[] {
  if (value === undefined) return [];
  const list = typeof value === "string" ? [value] : value;
  if (
    !Array.isArray(list) || list.length === 0 || list.length > 64 ||
    list.some((item) =>
      typeof item !== "string" || item.length === 0 || item.length > 4096
    )
  ) {
    throw invalidToken("aud must be a bounded string or nonempty string array");
  }
  return [...list];
}

function confirmation(
  value: unknown,
): VerifiedToken["cnf"] | undefined {
  if (value === undefined) return undefined;
  if (
    !isObject(value) || (value.jkt !== undefined &&
      (typeof value.jkt !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(value.jkt)))
  ) {
    throw invalidToken(
      "cnf must be an object with a valid SHA-256 jkt when present",
    );
  }
  return value as VerifiedToken["cnf"];
}

/**
 * The asymmetric algorithms accepted by default. A resource server does
 * not share a secret with the issuer, so HMAC is left out.
 */
export const DEFAULT_ACCESS_TOKEN_ALGORITHMS: readonly DpopAlgorithm[] = Object
  .freeze([
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
  ]);

/** Options for {@link jwtAccessTokenVerifier}. */
export interface JwtAccessTokenVerifierOptions {
  /** The expected `iss`, exactly (or one of these). */
  readonly issuer: string | readonly string[];
  /** This resource's identifier(s); the token's `aud` must name one. */
  readonly audience: string | readonly string[];
  /** The issuer's keys: a JWKS URL, a JWKS, or any `KeySet`. */
  readonly keys: string | Jwks | KeySet;
  /** Default {@link DEFAULT_ACCESS_TOKEN_ALGORITHMS}. */
  readonly algorithms?: readonly DpopAlgorithm[];
  /**
   * RFC 9068 strictly (the default): `typ` must be `at+jwt`, and `iss`,
   * `exp`, `aud`, `sub`, `client_id`, `iat` and `jti` are required.
   * False accepts any JWT with `iss`, `aud` and `exp`, for issuers that
   * predate the profile.
   */
  readonly strict?: boolean;
  /** Seconds of clock skew for `exp`, `nbf` and `iat` (0 to 86 400); default 30. */
  readonly clockToleranceSec?: number;
  /**
   * For a JWKS URL: the egress policy over `RemoteJwks`'s default (https,
   * no redirects, 5 s, 256 KiB, public addresses only). See
   * `@celld/http/egress`.
   */
  readonly egress?: Partial<EgressPolicy>;
  /**
   * For a JWKS URL: also allow `http:` to a loopback IP literal
   * (`http://127.0.0.1:8080/jwks`), for a development issuer on this
   * machine. Never set it in production. Default false.
   */
  readonly allowLoopbackForDevelopment?: boolean;
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
  input: JwtAccessTokenVerifierOptions,
): AccessTokenVerifier {
  // Read once: changing the caller's `audience` list afterwards (or its
  // issuer, algorithms or key set) changes nothing.
  strictRecord(input, [
    "issuer",
    "audience",
    "keys",
    "algorithms",
    "strict",
    "clockToleranceSec",
    "egress",
    "allowLoopbackForDevelopment",
    "fetch",
    "now",
  ], "jwtAccessTokenVerifier options");
  const options = snapshotOptions(input);
  if (options.strict !== undefined && typeof options.strict !== "boolean") {
    throw new TypeError("strict must be boolean");
  }
  // `@celld/sec/jwt` skips the `iss`/`aud` checks when they are not given, so
  // a caller the types did not stop would accept any issuer's tokens for
  // any audience.
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
      throw new TypeError(
        `jwtAccessTokenVerifier needs an ${what}: a non-empty string or list`,
      );
    }
  }
  if (
    options.algorithms !== undefined &&
    (options.algorithms.length === 0 ||
      !options.algorithms.every(isDpopAlgorithm))
  ) {
    throw new TypeError("jwtAccessTokenVerifier needs at least one algorithm");
  }
  const now = options.now ?? defaultClock;
  const tolerance = finite(options.clockToleranceSec ?? 30, {
    name: "clockToleranceSec",
    min: 0,
    max: 86_400,
  });
  let keys: KeySet;
  if (typeof options.keys === "string") {
    keys = new RemoteJwks(options.keys, {
      fetch: options.fetch,
      now,
      allowLoopbackForDevelopment: options.allowLoopbackForDevelopment === true,
      ...(options.egress === undefined ? {} : { egress: options.egress }),
    });
  } else if (Array.isArray((options.keys as Jwks).keys)) {
    keys = localJwks(options.keys as Jwks);
  } else {
    keys = options.keys as KeySet;
  }
  const strict = options.strict ?? true;
  const prepared = createVerifier({
    keys,
    algorithms: options.algorithms ?? DEFAULT_ACCESS_TOKEN_ALGORITHMS,
    typ: strict ? "at+jwt" : undefined,
    issuer: options.issuer,
    audience: options.audience,
    clockTolerance: tolerance,
    requiredClaims: strict
      ? ["iss", "exp", "aud", "sub", "client_id", "iat", "jti"]
      : ["exp"],
    now,
  });
  return {
    ready: () => prepared.ready(),
    async verify(token) {
      if (
        typeof token !== "string" || token.length === 0 || token.length > 16_384
      ) throw invalidToken("invalid access token length");
      let claims: Record<string, unknown>;
      try {
        ({ payload: claims } = await prepared.verify(token));
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
      return snapshot({
        subject,
        scopes: scopesOf(claims),
        clientId,
        issuer: claims.iss as string,
        audience: audiences(claims.aud),
        expiresAt: (claims.exp as number) * 1000,
        cnf: confirmation(claims.cnf),
        claims,
      });
    },
  };
}

/**
 * Options for {@link introspectionVerifier}. The request goes through
 * `boundedFetch` under the token-endpoint rule (https, public addresses,
 * no redirects, 10 s, 256 KiB): `egress` adjusts it (`{ network: "any" }`
 * for an endpoint on a private network), and `allowLoopbackForDevelopment`
 * allows `http:` to a loopback IP literal on this machine.
 */
export interface IntrospectionVerifierOptions extends EgressOptions {
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
  /** Require the extension iss member. Default false follows RFC 7662; conflicts always fail. */
  readonly requireIssuer?: boolean;
  /**
   * How long an active answer is reused (capped at its `exp`), in
   * milliseconds from 0 (never) to 86 400 000; default 60 000.
   */
  readonly cacheMs?: number;
  /** The most answers cached, a whole number from 1 to 1 000 000; default 10 000. */
  readonly maxEntries?: number;
  readonly fetch?: FetchLike;
  readonly now?: Clock;
}

/**
 * Whether an introspection answer's `token_type` names an access token:
 * absent, `Bearer` or `DPoP` (RFC 6749 section 7.1, any case),
 * `access_token`, or RFC 8693's access token type URI.
 */
function isAccessTokenType(value: unknown): boolean {
  if (value === undefined) return true;
  if (typeof value !== "string") return false;
  const lower = value.toLowerCase();
  return lower === "bearer" || lower === "dpop" ||
    value === "access_token" ||
    value === "urn:ietf:params:oauth:token-type:access_token";
}

/**
 * A verifier that asks the authorization server (RFC 7662). An active
 * answer is refused when its `token_type` is not an access token's
 * (absent, `Bearer`, `DPoP`, `access_token` or RFC 8693's URI: a refresh
 * token is active to the client holding it), its `iss` is not the issuer,
 * it names another audience (or none, with `requireAudience`), or its
 * `exp` or `nbf` say the token is not valid now. Active answers are
 * cached, keyed by the token's hash, for `cacheMs` or until `exp`.
 */
export function introspectionVerifier(
  input: IntrospectionVerifierOptions,
): AccessTokenVerifier {
  // Read once: the endpoint, credentials, audiences and `requireAudience`
  // cannot be changed on the caller's object afterwards.
  strictRecord(input, [
    "endpoint",
    "issuer",
    "client",
    "audience",
    "requireAudience",
    "requireIssuer",
    "cacheMs",
    "maxEntries",
    "fetch",
    "now",
    "egress",
    "allowLoopbackForDevelopment",
  ], "introspectionVerifier options");
  const options = snapshotOptions(input);
  if (!isIssuer(options.issuer)) {
    throw new TypeError("introspection issuer must be a valid issuer");
  }
  checkClientAuthentication(options.client);
  for (
    const name of [
      "requireAudience",
      "requireIssuer",
      "allowLoopbackForDevelopment",
    ] as const
  ) {
    if (
      options[name] !== undefined && typeof options[name] !== "boolean"
    ) throw new TypeError(`${name} must be boolean`);
  }
  const policy = endpointEgressPolicy(options);
  const problem = egressUrlProblem(options.endpoint, policy);
  if (problem !== null) {
    throw new TypeError(`introspection_endpoint ${problem}`);
  }
  const post = egressFetch(policy, options.fetch ?? defaultFetch);
  const now = options.now ?? defaultClock;
  const expected = typeof options.audience === "string"
    ? [options.audience]
    : [...options.audience];
  if (
    expected.length === 0 ||
    expected.some((v) =>
      typeof v !== "string" || v.length === 0 || v.length > 4096
    )
  ) throw new TypeError("introspection audience must be nonempty");
  const cacheMs = safeInt(options.cacheMs ?? 60_000, {
    name: "cacheMs",
    min: 0,
    max: 86_400_000,
  });
  const maxEntries = safeInt(options.maxEntries ?? 10_000, {
    name: "maxEntries",
    min: 1,
    max: 1_000_000,
  });
  const cache = new Map<string, { until: number; value: VerifiedToken }>();
  const negative = new Map<string, number>();
  const work = new OutboundWork(now);
  const origin = new URL(options.endpoint).origin;
  return {
    ready: async () => {
      if (options.client.method === "private_key_jwt") {
        await assertAlgorithmsSupported([options.client.alg]);
      }
    },
    async verify(token) {
      if (
        typeof token !== "string" || token.length === 0 || token.length > 16_384
      ) throw invalidToken("invalid token length");
      const key = await sha256(token);
      const hit = cache.get(key);
      if (hit !== undefined && hit.until > now()) return hit.value;
      cache.delete(key);
      if ((negative.get(key) ?? 0) > now()) {
        throw invalidToken("the token is not active");
      }
      negative.delete(key);
      return await work.run(key, origin, async () => {
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
          const response = await post(options.endpoint, {
            method: "POST",
            headers: {
              "content-type": "application/x-www-form-urlencoded",
              accept: "application/json",
              ...applied.headers,
            },
            body: body.toString(),
          });
          if (!response.ok) {
            await response.discard();
            answer = null;
          } else {
            const value = await response.json().catch((cause) => {
              if (cause instanceof EgressError && cause.code === "json") {
                return null;
              }
              throw cause;
            });
            answer = isObject(value) ? value : null;
          }
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
        if (answer.active !== true) {
          negative.set(key, now() + 2000);
          while (negative.size > maxEntries) {
            negative.delete(negative.keys().next().value!);
          }
          throw invalidToken("the token is not active");
        }
        // An active refresh token (which a server answers to the client that
        // holds it) is not a credential for the resource.
        if (!isAccessTokenType(answer.token_type)) {
          throw invalidToken("the token is not an access token");
        }
        if (
          (answer.iss === undefined && options.requireIssuer === true) ||
          (answer.iss !== undefined && answer.iss !== options.issuer)
        ) {
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
        for (const field of ["exp", "nbf", "iat"]) {
          if (
            answer[field] !== undefined &&
            (typeof answer[field] !== "number" ||
              !Number.isFinite(answer[field]))
          ) throw invalidToken("the token has an invalid time claim");
        }
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
        if (subject === undefined) {
          throw invalidToken("the token has no subject");
        }
        const value: VerifiedToken = snapshot({
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
        });
        if (cacheMs > 0) {
          cache.set(key, {
            until: Math.min(clock + cacheMs, value.expiresAt ?? Infinity),
            value,
          });
          while (cache.size > maxEntries) {
            const oldest = cache.keys().next();
            if (oldest.done) break;
            cache.delete(oldest.value);
          }
        }
        return value;
      });
    },
  };
}

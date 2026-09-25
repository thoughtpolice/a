// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * Token schemes: {@link bearer} (RFC 6750) and {@link dpop} (RFC 9449),
 * both around a {@link TokenVerifier} hook that does the actual checking,
 * so a JWT verifier, an introspection client or `@celld/oauth` can plug in.
 *
 * @module
 */

import {
  AuthError,
  type AuthOutcome,
  type AuthScheme,
  type Challenge,
  type ChallengeOptions,
  challengeParams,
  parseAuthorization,
  type PrincipalInput,
  TOKEN68,
} from "./auth.ts";
import type { Context } from "./context.ts";

/** Everything a token verifier may need, including what DPoP proofs are checked against. */
export interface TokenRequest {
  /** The access token, as sent. */
  readonly token: string;
  /** The `Authorization` scheme it came with (`Bearer` for a query token). */
  readonly scheme: "Bearer" | "DPoP";
  /** The `DPoP` header (a proof JWT), or null. */
  readonly proof: string | null;
  /** The request method, the proof's `htm`. */
  readonly method: string;
  /**
   * The full request URL. A DPoP proof's `htu` is compared with it without
   * its query and fragment (RFC 9449 section 4.3).
   */
  readonly url: string;
  readonly request: Request;
  readonly context: Context;
}

/**
 * Checks a token: a principal (with `cnf.jkt` for a DPoP-bound token),
 * null for a token that is not valid (`invalid_token`), or an
 * {@link AuthError} for anything more specific (`invalid_dpop_proof`,
 * `use_dpop_nonce` with a `DPoP-Nonce` header, ...). Throwing an
 * `AuthError` works too; any other exception is a 500. A principal's
 * `headers` (a fresh `DPoP-Nonce`, say) go on whatever response the
 * request gets.
 */
export type TokenVerifier = (
  request: TokenRequest,
) => AuthOutcome | Promise<AuthOutcome>;

/**
 * Options for {@link bearer}. `realm` and `resourceMetadata` (RFC 9728)
 * go on every challenge, 401 and 403 alike; neither is sent by default.
 */
export interface BearerOptions extends ChallengeOptions {
  readonly verify: TokenVerifier;
  /**
   * Accept the token in the `access_token` query parameter (RFC 6750
   * section 2.3). Default false: such a request is a 400, since URLs end up
   * in logs, histories and `Referer` headers.
   */
  readonly allowQuery?: boolean;
  /**
   * Accept a token the verifier says is DPoP-bound (`cnf.jkt`) without a
   * proof. Default false: a bound token presented as a bearer token is
   * `invalid_token` (RFC 9449 section 7.2).
   */
  readonly allowBound?: boolean;
  /** Default `bearer`. */
  readonly name?: string;
  /** For OpenAPI's `bearerFormat`, such as `JWT`. */
  readonly bearerFormat?: string;
}

async function run(
  verify: TokenVerifier,
  request: TokenRequest,
): Promise<AuthOutcome> {
  try {
    return await verify(request);
  } catch (error) {
    if (error instanceof AuthError) return error;
    throw error;
  }
}

/**
 * RFC 6750 bearer tokens from `Authorization: Bearer <token>`.
 *
 * - No bearer credential: null (the next scheme is tried; the 401 carries
 *   `Bearer` or `Bearer realm="..."`).
 * - A token that is not token68, a token in the query string (unless
 *   `allowQuery`), or in both places: 400 `invalid_request`.
 * - The verifier says no: 401 `invalid_token`.
 * - Missing a route's scope: 403 `insufficient_scope` with `scope`.
 */
export function bearer(options: BearerOptions): AuthScheme {
  const name = options.name ?? "bearer";
  return {
    name,
    async authenticate(c) {
      const header = parseAuthorization(c.req.headers.get("authorization"));
      const isBearer = header !== null &&
        header.scheme.toLowerCase() === "bearer";
      const query = c.url.searchParams.getAll("access_token");
      let token: string;
      if (query.length > 0) {
        if (!options.allowQuery) {
          return new AuthError(
            "invalid_request",
            "access tokens in the query string are refused",
          );
        }
        if (isBearer || query.length > 1) {
          return new AuthError(
            "invalid_request",
            "more than one access token was sent",
          );
        }
        token = query[0];
      } else if (isBearer) {
        token = header.credentials;
      } else {
        return null;
      }
      if (!TOKEN68.test(token)) {
        return new AuthError(
          "invalid_request",
          "the bearer token is malformed",
        );
      }
      const verdict = await run(options.verify, {
        token,
        scheme: "Bearer",
        proof: c.req.headers.get("dpop"),
        method: c.req.method,
        url: c.req.url,
        request: c.req,
        context: c,
      });
      if (verdict === null) {
        return new AuthError("invalid_token", "the access token is not valid");
      }
      if (verdict instanceof AuthError) return verdict;
      if (verdict.cnf?.jkt !== undefined && !options.allowBound) {
        return new AuthError(
          "invalid_token",
          "the access token is DPoP-bound; send it with a DPoP proof",
        );
      }
      return verdict;
    },
    challenge(error): Challenge {
      return { scheme: "Bearer", params: challengeParams(options, error) };
    },
    openapi: {
      type: "http",
      scheme: "bearer",
      ...(options.bearerFormat === undefined
        ? {}
        : { bearerFormat: options.bearerFormat }),
    },
  };
}

/**
 * Options for {@link dpop}. `realm` and `resourceMetadata` (RFC 9728) go
 * on every challenge; neither is sent by default.
 */
export interface DpopOptions extends ChallengeOptions {
  /**
   * Checks the token and its proof: the proof's signature, `typ`
   * (`dpop+jwt`), `htm`, `htu`, `iat`, `jti` replay, `ath` (the token's
   * hash), a nonce if one is required, and that the proof key's thumbprint
   * is the token's `cnf.jkt`. It returns the principal with `cnf.jkt`.
   */
  readonly verify: TokenVerifier;
  /** Proof algorithms accepted, for the challenge's `algs`; default ES256, RS256, PS256. */
  readonly algs?: readonly string[];
  /**
   * The current server nonce: when set, every response to a DPoP request
   * carries it as `DPoP-Nonce` (RFC 9449 section 8), and the verifier
   * answers `use_dpop_nonce` for a proof without it. A verifier that
   * issues its own nonces returns them in the principal's `headers` (and
   * the `AuthError`'s) instead.
   */
  readonly nonce?: (c: Context) => string | Promise<string>;
  /** Default `dpop`. */
  readonly name?: string;
}

const PROOF = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;

/**
 * RFC 9449 DPoP-bound tokens: `Authorization: DPoP <token>` plus a `DPoP`
 * proof header. The router checks the shape (one proof, a compact JWS);
 * the verifier does the cryptography and binding, and must return a
 * principal with `cnf.jkt`.
 *
 * - No DPoP credential: null (the 401 carries `DPoP algs="ES256 RS256 PS256"`).
 * - A malformed token: 400 `invalid_request`. No proof, several proofs or a
 *   malformed one: 401 `invalid_dpop_proof`.
 * - The verifier says no: 401 `invalid_token`, or its own error
 *   (`use_dpop_nonce` with `DPoP-Nonce`, ...).
 */
export function dpop(options: DpopOptions): AuthScheme {
  const name = options.name ?? "dpop";
  const algs: (readonly [string, string])[] = [
    ["algs", (options.algs ?? ["ES256", "RS256", "PS256"]).join(" ")],
  ];
  return {
    name,
    async authenticate(c) {
      const header = parseAuthorization(c.req.headers.get("authorization"));
      if (header === null || header.scheme.toLowerCase() !== "dpop") {
        return null;
      }
      if (options.nonce !== undefined) {
        c.header("dpop-nonce", await options.nonce(c));
      }
      if (!TOKEN68.test(header.credentials)) {
        return new AuthError("invalid_request", "the DPoP token is malformed");
      }
      const proof = c.req.headers.get("dpop");
      if (proof === null) {
        return new AuthError(
          "invalid_dpop_proof",
          "the request has no DPoP proof",
        );
      }
      if (!PROOF.test(proof.trim())) {
        return new AuthError(
          "invalid_dpop_proof",
          "the DPoP proof is malformed",
        );
      }
      const verdict = await run(options.verify, {
        token: header.credentials,
        scheme: "DPoP",
        proof: proof.trim(),
        method: c.req.method,
        url: c.req.url,
        request: c.req,
        context: c,
      });
      if (verdict === null) {
        return new AuthError("invalid_token", "the access token is not valid");
      }
      if (verdict instanceof AuthError) return verdict;
      if (verdict.cnf?.jkt === undefined) {
        return new AuthError(
          "invalid_token",
          "the access token is not DPoP-bound",
        );
      }
      return verdict satisfies PrincipalInput;
    },
    challenge(error): Challenge {
      return { scheme: "DPoP", params: challengeParams(options, error, algs) };
    },
    openapi: { type: "http", scheme: "dpop" },
  };
}

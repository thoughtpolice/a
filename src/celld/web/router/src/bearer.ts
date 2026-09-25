// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * {@link bearer} (RFC 6750) and the {@link TokenVerifier} hook it and
 * `dpop` hand access tokens to, so a JWT verifier, an introspection client
 * or `@celld/sec/oauth` can plug in.
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
  TOKEN68,
} from "./auth.ts";
import { type Context, requestOf } from "./context.ts";
import { RouterError } from "./errors.ts";
import { cleartextRefusal } from "./public_url.ts";
import {
  HTTP_TOKEN,
  optionsRecord,
  optionText,
  optionType,
} from "./validation.ts";

/**
 * What a token verifier gets: the access token and the request. There is
 * no DPoP proof here: `dpop` verifies the proof itself before it asks,
 * and checks the token's `cnf.jkt` against the proof's key after, so a
 * verifier only ever vouches for the token.
 */
export interface TokenRequest {
  /** The access token, as sent. */
  readonly token: string;
  /** The `Authorization` scheme it came with (`Bearer` for a query token). */
  readonly scheme: "Bearer" | "DPoP";
  /** The request method. */
  readonly method: string;
  /** The full request URL, as the Worker received it. */
  readonly url: string;
  /** `context.req`: the request, its body behind the router's limits. */
  readonly request: Request;
  readonly context: Context;
}

/**
 * Checks an access token: a principal (with `cnf.jkt` for a DPoP-bound
 * token), null for a token that is not valid (`invalid_token`), or an
 * {@link AuthError} for anything more specific. Throwing an
 * `AuthError` works too; any other exception is a 500. A principal's
 * `headers` (a fresh `DPoP-Nonce`, say) go on whatever response the
 * request gets.
 */
export type TokenVerifier =
  & ((
    request: TokenRequest,
  ) => AuthOutcome | Promise<AuthOutcome>)
  & { readonly ready?: () => Promise<void> };

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

/** A frozen copy of the challenge parameters in `options`. */
export function challengeOptions(options: ChallengeOptions): ChallengeOptions {
  optionText(options.realm, "challenge realm");
  optionText(options.resourceMetadata, "resourceMetadata");
  if (options.resourceMetadata !== undefined) {
    let url: URL;
    try {
      url = new URL(options.resourceMetadata);
    } catch {
      throw new RouterError("resourceMetadata must be an HTTP(S) URL");
    }
    if (
      !["http:", "https:"].includes(url.protocol) || url.username ||
      url.password || url.hash
    ) {
      throw new RouterError(
        "resourceMetadata must be an HTTP(S) URL without credentials or fragment",
      );
    }
  }
  return Object.freeze({
    ...(options.realm === undefined ? {} : { realm: String(options.realm) }),
    ...(options.resourceMetadata === undefined
      ? {}
      : { resourceMetadata: String(options.resourceMetadata) }),
  });
}

/** Runs a verifier; a thrown {@link AuthError} is its answer. */
export async function run(
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
 * - A token over plain http (unless the public URL is a loopback IP
 *   literal, or the router allows cleartext credentials for development):
 *   403 `insecure_transport`, without a challenge.
 * - No bearer credential: null (the next scheme is tried; the 401 carries
 *   `Bearer` or `Bearer realm="..."`).
 * - A token that is not token68, a token in the query string (unless
 *   `allowQuery`), or in both places: 400 `invalid_request`.
 * - The verifier says no: 401 `invalid_token`.
 * - Missing a route's scope: 403 `insufficient_scope` with `scope`.
 */
export function bearer(options: BearerOptions): AuthScheme {
  optionsRecord(options, [
    "verify",
    "allowQuery",
    "allowBound",
    "name",
    "bearerFormat",
    "realm",
    "resourceMetadata",
  ], "bearer options");
  optionType(options.allowQuery, "boolean", "bearer allowQuery");
  optionType(options.allowBound, "boolean", "bearer allowBound");
  optionText(options.name, "bearer name", HTTP_TOKEN);
  optionText(options.bearerFormat, "bearerFormat");
  const {
    verify,
    allowQuery = false,
    allowBound = false,
    name = "bearer",
    bearerFormat,
  } = options;
  if (typeof verify !== "function") {
    throw new RouterError("bearer needs a verify function");
  }
  const challenge = challengeOptions(options);
  return {
    name,
    ambient: false,
    ...(verify.ready === undefined ? {} : { ready: () => verify.ready!() }),
    async authenticate(c) {
      const header = parseAuthorization(
        requestOf(c).headers.get("authorization"),
      );
      const isBearer = header !== null &&
        header.scheme.toLowerCase() === "bearer";
      const query = c.url.searchParams.getAll("access_token");
      let token: string;
      if (query.length > 0) {
        if (!allowQuery) {
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
      const refused = cleartextRefusal(c, "bearer tokens");
      if (refused !== null) return refused;
      if (token.length > 16384 || !TOKEN68.test(token)) {
        return new AuthError(
          "invalid_request",
          "the bearer token is malformed",
        );
      }
      const verdict = await run(verify, {
        token,
        scheme: "Bearer",
        method: c.method,
        url: c.url.href,
        get request() {
          return c.req;
        },
        context: c,
      });
      if (verdict === null) {
        return new AuthError("invalid_token", "the access token is not valid");
      }
      if (verdict instanceof AuthError) return verdict;
      if (
        verdict.cnf !== undefined &&
        (verdict.cnf === null || typeof verdict.cnf !== "object" ||
          Array.isArray(verdict.cnf) || typeof verdict.cnf.jkt !== "string" ||
          !/^[A-Za-z0-9_-]{1,256}$/.test(verdict.cnf.jkt))
      ) {
        return new AuthError(
          "invalid_token",
          "the access token confirmation is malformed",
        );
      }
      if (verdict.cnf?.jkt !== undefined && !allowBound) {
        return new AuthError(
          "invalid_token",
          "the access token is DPoP-bound; send it with a DPoP proof",
        );
      }
      return verdict.tokenType === undefined
        ? { ...verdict, tokenType: "Bearer" }
        : verdict;
    },
    challenge(error): Challenge {
      return { scheme: "Bearer", params: challengeParams(challenge, error) };
    },
    openapi: {
      type: "http",
      scheme: "bearer",
      ...(bearerFormat === undefined ? {} : { bearerFormat }),
    },
  };
}

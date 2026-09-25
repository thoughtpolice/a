// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * Claims: the standard ones (OpenID Connect Core section 5.1), the scopes
 * that ask for them (section 5.4), the `claims` request parameter
 * (section 5.5), and the members an ID token has (section 2).
 *
 * @module
 */

import { isObject } from "./util.ts";

/** The `openid` scope, which makes an OAuth request an OpenID Connect one. */
export const OPENID_SCOPE = "openid";

/** Section 5.4: the claims each standard scope asks for. */
export const SCOPE_CLAIMS: Readonly<Record<string, readonly string[]>> = {
  profile: [
    "name",
    "family_name",
    "given_name",
    "middle_name",
    "nickname",
    "preferred_username",
    "profile",
    "picture",
    "website",
    "gender",
    "birthdate",
    "zoneinfo",
    "locale",
    "updated_at",
  ],
  email: ["email", "email_verified"],
  address: ["address"],
  phone: ["phone_number", "phone_number_verified"],
};

/** Every standard claim of section 5.1, `sub` first. */
export const STANDARD_CLAIMS: readonly string[] = [
  "sub",
  ...Object.values(SCOPE_CLAIMS).flat(),
];

/**
 * Claims an ID token's issuer sets itself, which a host's claims can never
 * replace (section 2, plus `sid` from Front-Channel Logout and `cnf`).
 */
export const ID_TOKEN_PROTOCOL_CLAIMS: ReadonlySet<string> = new Set([
  "iss",
  "sub",
  "aud",
  "exp",
  "iat",
  "nbf",
  "jti",
  "auth_time",
  "nonce",
  "acr",
  "amr",
  "azp",
  "at_hash",
  "c_hash",
  "sid",
  "cnf",
]);

/** The claims of an ID token (section 2). */
export interface IdTokenClaims {
  readonly iss: string;
  readonly sub: string;
  readonly aud: string | readonly string[];
  readonly exp: number;
  readonly iat: number;
  readonly auth_time?: number;
  readonly nonce?: string;
  readonly acr?: string;
  readonly amr?: readonly string[];
  readonly azp?: string;
  readonly at_hash?: string;
  readonly c_hash?: string;
  readonly sid?: string;
  readonly [claim: string]: unknown;
}

/** One claim's request (section 5.5.1): null, or these members. */
export interface ClaimRequest {
  readonly essential?: boolean;
  readonly value?: unknown;
  readonly values?: readonly unknown[];
}

/** The `claims` request parameter (section 5.5). */
export interface ClaimsRequest {
  readonly userinfo?: Readonly<Record<string, ClaimRequest | null>>;
  readonly id_token?: Readonly<Record<string, ClaimRequest | null>>;
}

/** Why a `claims` parameter is malformed. */
export class ClaimsRequestError extends Error {
  override name = "ClaimsRequestError";
}

function member(
  value: unknown,
  where: string,
): Record<string, ClaimRequest | null> | undefined {
  if (value === undefined) return undefined;
  if (!isObject(value)) {
    throw new ClaimsRequestError(`claims.${where} must be an object`);
  }
  const out: Record<string, ClaimRequest | null> = {};
  for (const [name, request] of Object.entries(value)) {
    if (request === null) {
      out[name] = null;
      continue;
    }
    if (!isObject(request)) {
      throw new ClaimsRequestError(
        `claims.${where}.${name} must be null or an object`,
      );
    }
    if (
      request.essential !== undefined && typeof request.essential !== "boolean"
    ) {
      throw new ClaimsRequestError(
        `claims.${where}.${name}.essential must be a boolean`,
      );
    }
    if (request.values !== undefined && !Array.isArray(request.values)) {
      throw new ClaimsRequestError(
        `claims.${where}.${name}.values must be an array`,
      );
    }
    out[name] = request as ClaimRequest;
  }
  return out;
}

/**
 * Parses a `claims` parameter. Members other than `userinfo` and
 * `id_token` are ignored (section 5.5); anything malformed throws a
 * {@link ClaimsRequestError}.
 */
export function parseClaimsRequest(text: string): ClaimsRequest {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new ClaimsRequestError("claims is not JSON");
  }
  if (!isObject(parsed)) {
    throw new ClaimsRequestError("claims must be a JSON object");
  }
  const userinfo = member(parsed.userinfo, "userinfo");
  const idToken = member(parsed.id_token, "id_token");
  return {
    ...(userinfo === undefined ? {} : { userinfo }),
    ...(idToken === undefined ? {} : { id_token: idToken }),
  };
}

/** The standard claims the scopes ask for, in {@link SCOPE_CLAIMS} order. */
export function claimsForScopes(scopes: readonly string[]): string[] {
  const out: string[] = [];
  for (const scope of scopes) {
    for (const claim of SCOPE_CLAIMS[scope] ?? []) {
      if (!out.includes(claim)) out.push(claim);
    }
  }
  return out;
}

/**
 * The acceptable `acr` values a request names: an essential `acr` claim
 * request's `value` or `values`, else `acr_values`. Empty for none.
 */
export function requestedAcrValues(
  claims: ClaimsRequest | undefined,
  acrValues: string | undefined,
): { readonly values: readonly string[]; readonly essential: boolean } {
  const request = claims?.id_token?.acr;
  if (request !== undefined && request !== null) {
    const values = request.values !== undefined
      ? request.values.filter((item): item is string =>
        typeof item === "string"
      )
      : typeof request.value === "string"
      ? [request.value]
      : [];
    if (values.length > 0) {
      return { values, essential: request.essential === true };
    }
  }
  const split = (acrValues ?? "").split(" ").filter((item) => item !== "");
  return { values: split, essential: false };
}

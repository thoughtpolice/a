// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * {@link IdTokenError}: why an ID token was refused. Every other client
 * failure is `@celld/oauth`'s `OAuthError`, and server refusals are its
 * `ProtocolError`.
 *
 * @module
 */

/** Which check of OpenID Connect Core section 3.1.3.7 an ID token failed. */
export type IdTokenErrorCode =
  /** Not a compact JWS with JSON header and claims. */
  | "malformed"
  /** `alg` is not one the client accepts (never `none` or HMAC). */
  | "alg"
  /** No key of the issuer verifies it (after refetching for an unknown `kid`). */
  | "signature"
  /** The issuer's keys could not be fetched. */
  | "keys"
  /** A required claim is missing or has the wrong type. */
  | "claims"
  | "iss"
  /** `aud` does not name the client, or names an audience it does not trust. */
  | "aud"
  /** `azp` is not the client, or is missing with several audiences. */
  | "azp"
  | "exp"
  /** `iat` is in the future or too long ago. */
  | "iat"
  /** `nonce` is missing or not the one sent. */
  | "nonce"
  /** `auth_time` is missing when it must be there, too old for `max_age`, or changed. */
  | "auth_time"
  /** `acr` is not one of the values asked for. */
  | "acr"
  | "at_hash"
  | "c_hash"
  /** `sub` is not the one expected (a refresh or UserInfo answer about someone else). */
  | "sub";

/** An ID token the relying party refuses. */
export class IdTokenError extends Error {
  override name = "IdTokenError";
  readonly code: IdTokenErrorCode;

  constructor(code: IdTokenErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.code = code;
  }
}

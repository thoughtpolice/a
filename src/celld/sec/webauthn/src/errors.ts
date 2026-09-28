// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * {@link WebAuthnError}: why a ceremony failed, as a stable code.
 *
 * @module
 */

/**
 * Why a registration or authentication was refused. The codes are stable
 * and safe to log; messages add detail for developers. None of them is
 * meant for the user: tell a user only that sign-in failed, since the
 * difference between, say, an unknown credential and a bad signature is
 * for the server.
 */
export type WebAuthnErrorCode =
  /** The response is not the JSON a browser sends, or a field is malformed. */
  | "invalid_response"
  /** The client data's `type` is not this ceremony's. */
  | "wrong_ceremony"
  /** The client data's challenge is not the one issued. */
  | "challenge_mismatch"
  /** The challenge is unknown, expired, or already used. */
  | "challenge_expired"
  /** The origin (or the top origin of a frame) is not allowed. */
  | "origin_not_allowed"
  /** The credential is scoped to another relying party ID. */
  | "rp_id_mismatch"
  /** The authenticator did not test that a user was present. */
  | "user_not_present"
  /** User verification was required and did not happen. */
  | "user_not_verified"
  /** The BE and BS flags are inconsistent, or BE changed. */
  | "backup_flags"
  /** The credential's algorithm is not one the relying party accepts. */
  | "unsupported_algorithm"
  /** The attestation format is not `none` or packed self attestation. */
  | "unsupported_attestation"
  /** A signature (assertion or attestation) did not verify. */
  | "bad_signature"
  /** The credential is not registered, or not to this user. */
  | "unknown_credential"
  /** The user handle does not match the credential's user. */
  | "user_handle_mismatch"
  /** The signature counter did not advance: the authenticator may be cloned. */
  | "counter_regressed"
  /** The credential ID is already registered. */
  | "credential_exists";

/** A refused ceremony; see {@link WebAuthnErrorCode}. */
export class WebAuthnError extends Error {
  override readonly name = "WebAuthnError";
  readonly code: WebAuthnErrorCode;

  constructor(
    code: WebAuthnErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.code = code;
  }
}

// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * {@link JwtError}, the one error this library throws, with a code saying
 * what was wrong.
 *
 * @module
 */

/**
 * Why a token, key or key set was refused:
 *
 * - `malformed`: not three base64url parts of a JSON header and claims.
 * - `unsupported_alg`: `alg` is `none` or not one this library implements.
 * - `alg_not_allowed`: `alg` is not in the verifier's `algorithms`.
 * - `key_mismatch`: the key is the wrong type, size, curve or hash for
 *   `alg`, or lacks the usage (a private key to verify, say).
 * - `no_key`: no key in the set fits the token's `kid` and `alg`.
 * - `jwks`: a remote key set could not be fetched or was not a JWKS.
 * - `bad_signature`: the signature does not verify.
 * - `runtime_unsupported`: the runtime's WebCrypto refused the operation
 *   itself (a `NotSupportedError`), so the token was never checked: celld
 *   0.5.1 cannot verify Ed25519 or import an `oct` JWK, say. The runtime's
 *   exception is the `cause`. This is the server's problem, not the
 *   token's; answer it as a 500, not as a bad credential.
 * - `crit`, `typ`: a critical header the caller did not list, or a `typ`
 *   it did not expect.
 * - `expired`, `not_yet_valid`, `too_old`: `exp`, `nbf`, or `iat` with
 *   `maxTokenAge`, against the clock and its tolerance.
 * - `issuer`, `audience`, `subject`: the claim is not the expected one.
 * - `missing_claim`, `invalid_claim`: a required claim is absent, or a
 *   registered claim has the wrong JSON type.
 */
export type JwtErrorCode =
  | "malformed"
  | "unsupported_alg"
  | "alg_not_allowed"
  | "key_mismatch"
  | "no_key"
  | "jwks"
  | "bad_signature"
  | "runtime_unsupported"
  | "crit"
  | "typ"
  | "expired"
  | "not_yet_valid"
  | "too_old"
  | "issuer"
  | "audience"
  | "subject"
  | "missing_claim"
  | "invalid_claim";

/** A refused token, key or key set; see {@link JwtErrorCode}. */
export class JwtError extends Error {
  override name = "JwtError";
  readonly code: JwtErrorCode;

  constructor(code: JwtErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.code = code;
  }
}

/**
 * Whether `error` is the runtime refusing a WebCrypto operation it does
 * not implement (a `DOMException` named `NotSupportedError`).
 */
export function isRuntimeUnsupported(error: unknown): boolean {
  return typeof error === "object" && error !== null &&
    (error as { name?: unknown }).name === "NotSupportedError";
}

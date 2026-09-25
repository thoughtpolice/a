// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * Proof Key for Code Exchange (RFC 7636), S256 only. OAuth 2.1 makes PKCE
 * mandatory for the authorization code grant, and `plain` offers nothing
 * against an attacker who can read the authorization request, so neither
 * side here ever uses it.
 *
 * @module
 */

import { randomToken, sha256, timingSafeEqual } from "./util.ts";

/** A verifier and its S256 challenge. */
export interface PkcePair {
  readonly verifier: string;
  readonly challenge: string;
  readonly method: "S256";
}

const VERIFIER = /^[A-Za-z0-9\-._~]{43,128}$/;

/**
 * Whether `value` is a valid code verifier (RFC 7636 section 4.1): 43 to
 * 128 characters from the unreserved set. A code challenge has the same
 * syntax.
 */
export function isCodeVerifier(value: string): boolean {
  return VERIFIER.test(value);
}

/** The S256 code challenge of a verifier: base64url(SHA-256(verifier)). */
export async function pkceChallenge(verifier: string): Promise<string> {
  return await sha256(verifier);
}

/** A new pair: a 43-character verifier with 256 bits of entropy, and its challenge. */
export async function pkcePair(): Promise<PkcePair> {
  const verifier = randomToken(32);
  return { verifier, challenge: await pkceChallenge(verifier), method: "S256" };
}

/**
 * Whether `verifier` is well formed and hashes to `challenge`, compared in
 * constant time.
 */
export async function verifyPkce(
  verifier: string,
  challenge: string,
): Promise<boolean> {
  if (!isCodeVerifier(verifier)) return false;
  return timingSafeEqual(await pkceChallenge(verifier), challenge);
}

// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * The left-half hashes an ID token carries (OpenID Connect Core sections
 * 3.1.3.6 and 3.3.2.11): `at_hash` of the access token and `c_hash` of
 * the code, each the base64url of the left-most half of the hash of the
 * value's ASCII octets, with the hash of the ID token's `alg`.
 *
 * @module
 */

import { toBase64Url } from "@celld/jwt";

/** The WebCrypto hash an ID token `alg` implies, or null for one without (`none`). */
export function hashForAlgorithm(
  alg: string,
): "SHA-256" | "SHA-384" | "SHA-512" | null {
  const match = /^(?:RS|PS|ES|HS)(256|384|512)$/.exec(alg);
  if (match !== null) return `SHA-${match[1]}` as "SHA-256";
  // Ed25519 signs with SHA-512 inside, so its left-half hashes use it too.
  if (alg === "EdDSA" || alg === "Ed25519") return "SHA-512";
  return null;
}

/**
 * The `at_hash` or `c_hash` of `value` for an ID token signed with `alg`.
 * Throws `TypeError` for an algorithm without a hash.
 */
export async function tokenHash(value: string, alg: string): Promise<string> {
  const hash = hashForAlgorithm(alg);
  if (hash === null) throw new TypeError(`no hash for alg ${alg}`);
  const digest = new Uint8Array(
    await crypto.subtle.digest(hash, new TextEncoder().encode(value)),
  );
  return toBase64Url(digest.subarray(0, digest.length / 2));
}

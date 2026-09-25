// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * Helpers shared by the suites.
 *
 * @module
 */

import {
  type JwsAlgorithm,
  JwtError,
  type JwtErrorCode,
  type KeyLike,
  signBytes,
  toBase64Url,
} from "@celld/sec/jwt";

/** Adversarial fixture only: bypass safe JWT semantic checks. */
export async function rawSign(
  claims: unknown,
  key: KeyLike,
  alg: JwsAlgorithm,
  header: Record<string, unknown> = {},
): Promise<string> {
  const input = `${
    toBase64Url(JSON.stringify({ alg, typ: "JWT", ...header }))
  }.${toBase64Url(JSON.stringify(claims))}`;
  return `${input}.${
    toBase64Url(await signBytes(alg, key, new TextEncoder().encode(input)))
  }`;
}

/** Asserts that `fn` throws, or its promise rejects, a JwtError with `code`. */
export async function rejects(
  fn: () => unknown,
  code: JwtErrorCode,
): Promise<JwtError> {
  try {
    await fn();
  } catch (error) {
    if (error instanceof JwtError && error.code === code) return error;
    throw new Error(`expected JwtError ${code}, got ${error}`);
  }
  throw new Error(`expected JwtError ${code}, got success`);
}

/** Base64url of a JSON value. */
export function part(value: unknown): string {
  return btoa(JSON.stringify(value)).replaceAll("+", "-").replaceAll("/", "_")
    .replace(/=+$/, "");
}

/** A token with this header and payload and a fake signature. */
export function unsigned(
  header: unknown,
  payload: unknown,
  signature = "c2ln",
): string {
  return `${part(header)}.${part(payload)}.${signature}`;
}

// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * Helpers shared by the suites.
 *
 * @module
 */

import { JwtError, type JwtErrorCode } from "@celld/jwt";

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

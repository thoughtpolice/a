// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * Identifiers that go into request paths, checked before they are used, so
 * a name passed where an id belongs (a zone's name for its id, say) fails
 * here with a message rather than as a 404 or a request to another path.
 *
 * @module
 */

const HEX32 = /^[0-9a-f]{32}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const TOKEN = /^[A-Za-z0-9_-]{1,128}$/;

/**
 * An account, zone, record, ruleset or rule id: 32 lower-case hex digits.
 *
 * @throws {TypeError} otherwise.
 */
export function cloudflareId(value: unknown, name: string): string {
  if (typeof value !== "string" || !HEX32.test(value)) {
    throw new TypeError(
      `${name} must be a Cloudflare id (32 lower-case hex digits), got ${
        describe(value)
      }`,
    );
  }
  return value;
}

/**
 * A tunnel, connector or scan id: a lower-case UUID.
 *
 * @throws {TypeError} otherwise.
 */
export function uuid(value: unknown, name: string): string {
  if (typeof value !== "string" || !UUID.test(value)) {
    throw new TypeError(`${name} must be a UUID, got ${describe(value)}`);
  }
  return value;
}

/**
 * Any other path segment (a Turnstile sitekey, a setting id): letters,
 * digits, `_` and `-`, at most 128 of them.
 *
 * @throws {TypeError} otherwise.
 */
export function pathToken(value: unknown, name: string): string {
  if (typeof value !== "string" || !TOKEN.test(value)) {
    throw new TypeError(
      `${name} must be letters, digits, _ and -, got ${describe(value)}`,
    );
  }
  return value;
}

function describe(value: unknown): string {
  if (typeof value !== "string") return typeof value;
  return JSON.stringify(value.length > 80 ? `${value.slice(0, 80)}...` : value);
}

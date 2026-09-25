// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * JSON values and the canonical encoding the answer cache hashes.
 *
 * The JSON types are sieve's, re-exported so callers of `@celld/api/jev` need
 * not depend on `@celld/sieve` for them. Checking that a value is plain JSON
 * is `v.json()`'s job; see `schemas.ts`.
 *
 * @module
 */

export type { JsonObject, JsonPrimitive, JsonValue } from "@celld/sieve";

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/**
 * Encodes plain JSON in one fixed form, for hashing. Object keys keep their
 * order: the order of options, levels and fields is part of what the model
 * reads, so two requests that differ only in it are different requests.
 * Callers check the value with `v.json()` first; this throws on anything
 * that is not JSON rather than dropping or converting it.
 */
export function canonicalJson(value: unknown): string {
  if (
    value === null || typeof value === "string" || typeof value === "boolean"
  ) {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError(`${value} is not JSON`);
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (isPlainObject(value)) {
    return `{${
      Object.keys(value).map((key) =>
        `${JSON.stringify(key)}:${canonicalJson(value[key])}`
      ).join(",")
    }}`;
  }
  throw new TypeError(
    typeof value === "object"
      ? "a non-plain object is not JSON"
      : `${
        typeof value === "undefined" ? "undefined" : `a ${typeof value}`
      } is not JSON`,
  );
}

// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/** Dependency-free validation of plain configuration dictionaries. */

/**
 * Validate an options record without invoking getters. Only ordinary or
 * null-prototype objects and own, enumerable data properties are accepted.
 * Values are validated by the consuming API, which knows their semantics.
 */
export function strictRecord(
  value: unknown,
  allowedKeys: readonly string[],
  name = "options",
): asserts value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${name} must be a plain object`);
  }
  const proto = Object.getPrototypeOf(value);
  if (proto !== null && proto !== Object.prototype) {
    throw new TypeError(`${name} must have an ordinary or null prototype`);
  }
  for (const key of Reflect.ownKeys(value)) {
    // Most configuration schemas have only a handful of fields. Avoid making
    // a temporary Set on each hot-path numeric/body check.
    if (typeof key !== "string" || !allowedKeys.includes(key)) {
      throw new TypeError(`${name} has an unknown option`);
    }
    const property = Object.getOwnPropertyDescriptor(value, key)!;
    if (!property.enumerable || !("value" in property)) {
      throw new TypeError(`${name}.${key} must be an enumerable data property`);
    }
  }
}

/** Internal bounded diagnostic label check; never stringify user objects. */
export function checkName(value: unknown): asserts value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > 256) {
    throw new TypeError(
      "name must be a nonempty string of at most 256 characters",
    );
  }
}

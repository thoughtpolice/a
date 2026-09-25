// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * Configuration snapshots: what a constructor or a registration is given
 * is copied then, so changing the caller's objects afterwards (a tool's
 * `scopes`, the `versions` list, an Origin allowlist) changes nothing the
 * server or client does.
 *
 * @module
 */

/**
 * A frozen copy of configuration `value`: arrays and plain data objects
 * are copied and frozen, recursively. Objects that carry behaviour are
 * kept as they are, since they own their state: functions, class
 * instances (stores, schemas, change sources), typed arrays, objects
 * already frozen, and plain objects with a method or accessor.
 */
export function snapshot<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) {
    return value;
  }
  if (Array.isArray(value)) {
    return Object.freeze(value.map((item) => snapshot(item))) as T;
  }
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) return value;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const behaviour = Object.values(descriptors).some((descriptor) =>
    descriptor.get !== undefined || descriptor.set !== undefined ||
    typeof descriptor.value === "function"
  );
  if (behaviour) return value;
  const copy: Record<string, unknown> = proto === null
    ? Object.create(null)
    : {};
  for (const [name, item] of Object.entries(value)) {
    define(copy, name, snapshot(item));
  }
  return Object.freeze(copy) as T;
}

/**
 * Adds `name` as an own data property. Assignment would not: where
 * `Object.prototype.__proto__` is an accessor (workerd has it), an own
 * `__proto__` key from `JSON.parse` would set the copy's prototype.
 */
function define(copy: object, name: string, value: unknown): void {
  Object.defineProperty(copy, name, {
    value,
    enumerable: true,
    writable: true,
    configurable: true,
  });
}

/**
 * A frozen copy of an options object or a definition: each member through
 * {@link snapshot} (callbacks kept, data copied), the object itself frozen.
 */
export function snapshotOptions<T extends object>(options: T): T {
  const copy: Record<string, unknown> = {};
  for (const [name, item] of Object.entries(options)) {
    define(copy, name, snapshot(item));
  }
  return Object.freeze(copy) as T;
}

/**
 * A frozen lookup table without a prototype, so a key chosen by the peer
 * (`toString`, `constructor`, `__proto__`) finds nothing it did not list.
 */
export function table<T extends object>(entries: T): Readonly<T> {
  return Object.freeze(Object.assign(Object.create(null), entries));
}

/** An empty object without a prototype, for maps filled from peer keys. */
export function bag<T>(): Record<string, T> {
  return Object.create(null);
}

// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/** Strict configuration records and bounded, immutable JSON snapshots. */

import { utf8Length } from "./collections.ts";
import { safeInt } from "./numbers.ts";
import { strictRecord } from "./record.ts";

const SNAPSHOT_KEYS = Object.freeze(["maxDepth", "maxItems", "maxBytes"]);

/** Resource limits for {@link jsonSnapshot}; the byte cap includes JSON escaping. */
export interface SnapshotLimits {
  readonly maxDepth?: number;
  readonly maxItems?: number;
  readonly maxBytes?: number;
}

/**
 * Copy and recursively freeze JSON-compatible plain data without executing
 * getters, toJSON, or iterators. Reject cycles, sparse/decorated arrays,
 * non-finite numbers, symbols, prototype keys and non-JSON objects. Count work
 * and encoded bytes while copying, before an unbounded stringify/allocation.
 * Defaults: 32 levels, 4096 values/members, 64 KiB of encoded JSON.
 */
export function jsonSnapshot<T>(value: T, limits: SnapshotLimits = {}): T {
  strictRecord(limits, SNAPSHOT_KEYS, "snapshot limits");
  const maxDepth = safeInt(
    limits.maxDepth === undefined ? 32 : limits.maxDepth,
    {
      name: "maxDepth",
      min: 0,
      max: 128,
    },
  );
  const maxItems = safeInt(
    limits.maxItems === undefined ? 4096 : limits.maxItems,
    {
      name: "maxItems",
      min: 1,
    },
  );
  const maxBytes = safeInt(
    limits.maxBytes === undefined ? 65536 : limits.maxBytes,
    {
      name: "maxBytes",
      min: 1,
    },
  );
  let items = 0;
  let bytes = 0;
  const active = new Set<object>();
  const charge = (count: number) => {
    bytes += count;
    if (bytes > maxBytes) {
      throw new RangeError("JSON snapshot exceeds byte limit");
    }
  };
  const stringBytes = (text: string) => {
    // Check the lower bound before JSON.stringify can allocate an escaped copy.
    if (text.length > maxBytes - bytes) {
      throw new RangeError("JSON snapshot exceeds byte limit");
    }
    return utf8Length(JSON.stringify(text));
  };
  const visit = (input: unknown, level: number): unknown => {
    if (++items > maxItems || level > maxDepth) {
      throw new RangeError("JSON snapshot exceeds structural limit");
    }
    if (input === null || typeof input === "boolean") {
      charge(input === null || input === true ? 4 : 5);
      return input;
    }
    if (typeof input === "string") {
      charge(stringBytes(input));
      return input;
    }
    if (typeof input === "number" && Number.isFinite(input)) {
      charge(String(input).length);
      return input;
    }
    if (typeof input !== "object" || input === null) {
      throw new TypeError("JSON snapshot requires JSON values");
    }
    if (active.has(input)) {
      throw new TypeError("JSON snapshot contains a cycle");
    }
    active.add(input);
    try {
      const keys = Reflect.ownKeys(input);
      if (keys.length > maxItems - items + 1) {
        throw new RangeError("JSON snapshot exceeds member limit");
      }
      if (Array.isArray(input)) {
        if (
          Object.getPrototypeOf(input) !== Array.prototype ||
          keys.length !== input.length + 1 || input.length > maxItems - items
        ) throw new TypeError("JSON snapshot requires a dense plain array");
        charge(2 + Math.max(0, input.length - 1));
        const copy: unknown[] = [];
        for (let i = 0; i < input.length; i++) {
          const property = Object.getOwnPropertyDescriptor(input, String(i));
          if (!property?.enumerable || !("value" in property)) {
            throw new TypeError(
              "JSON snapshot refuses array accessors and holes",
            );
          }
          copy.push(visit(property.value, level + 1));
        }
        return Object.freeze(copy);
      }
      const proto = Object.getPrototypeOf(input);
      if (proto !== null && proto !== Object.prototype) {
        throw new TypeError("JSON snapshot requires plain objects");
      }
      charge(2 + Math.max(0, keys.length - 1));
      const copy: Record<string, unknown> = {};
      for (const key of keys) {
        if (
          typeof key !== "string" || key === "__proto__" ||
          key === "constructor" || key === "prototype"
        ) {
          throw new TypeError(
            "JSON snapshot refuses prototype and symbol keys",
          );
        }
        const property = Object.getOwnPropertyDescriptor(input, key)!;
        if (!property.enumerable || !("value" in property)) {
          throw new TypeError(
            "JSON snapshot refuses accessors and hidden properties",
          );
        }
        charge(stringBytes(key) + 1);
        copy[key] = visit(property.value, level + 1);
      }
      return Object.freeze(copy);
    } finally {
      active.delete(input);
    }
  };
  return visit(value, 0) as T;
}

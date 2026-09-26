// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * Caps on lists and strings at parse boundaries.
 *
 * @module
 */

import { BoundsError, describe } from "./error.ts";
import { safeInt } from "./numbers.ts";
import { checkName, strictRecord } from "./record.ts";

const LIST_KEYS = Object.freeze(["max", "name"]);
const STRING_KEYS = Object.freeze(["maxLength", "maxBytes", "name"]);

/** The UTF-8 length of `text`; lone surrogates count as U+FFFD (3 bytes). */
export function utf8Length(text: string): number {
  if (typeof text !== "string") {
    throw new BoundsError("type", "UTF-8 length requires a string");
  }
  // Every code unit is at least one byte and at most three.
  let total = 0;
  for (let i = 0; i < text.length; i++) {
    const unit = text.charCodeAt(i);
    if (unit < 0x80) total += 1;
    else if (unit < 0x800) total += 2;
    else if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = text.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        total += 4;
        i++;
      } else total += 3;
    } else total += 3;
  }
  return total;
}

/**
 * `items` if it is an array of at most `max` items.
 *
 * @throws {BoundsError} `type` for a non-array, `too_many` over the cap.
 * @throws {RangeError} when `max` is not a non-negative safe integer.
 */
export function boundedList<T>(
  items: readonly T[],
  options: { readonly max: number; readonly name: string },
): readonly T[] {
  strictRecord(options, LIST_KEYS, "list options");
  checkName(options.name);
  const max = safeInt(options.max, { name: "list max", min: 0 });
  if (!Array.isArray(items)) {
    throw new BoundsError(
      "type",
      `${options.name} must be a list, got ${describe(items)}`,
    );
  }
  if (items.length > max) {
    throw new BoundsError(
      "too_many",
      `${options.name} has ${items.length} items, more than ${max}`,
    );
  }
  return items;
}

/** A string cap: UTF-16 code units (`maxLength`) or UTF-8 bytes (`maxBytes`). */
export type StringBound =
  | {
    readonly maxLength: number;
    readonly maxBytes?: never;
    readonly name: string;
  }
  | {
    readonly maxBytes: number;
    readonly maxLength?: never;
    readonly name: string;
  };

/**
 * `value` if it is a string within the cap. `maxLength` counts UTF-16 code
 * units (`value.length`); `maxBytes` counts its UTF-8 encoding. Give
 * exactly one.
 *
 * @throws {BoundsError} `type` for a non-string, `too_large` over the cap.
 * @throws {RangeError} for a bad cap or both caps.
 */
export function boundedString(value: string, options: StringBound): string {
  strictRecord(options, STRING_KEYS, "string options");
  checkName(options.name);
  const { name } = options;
  const byLength = options.maxLength !== undefined;
  if (byLength === (options.maxBytes !== undefined)) {
    throw new RangeError(`${name}: give exactly one of maxLength and maxBytes`);
  }
  const max = safeInt(byLength ? options.maxLength : options.maxBytes, {
    name: byLength ? "maxLength" : "maxBytes",
    min: 0,
  });
  if (typeof value !== "string") {
    throw new BoundsError(
      "type",
      `${name} must be a string, got ${describe(value)}`,
    );
  }
  const size = byLength ? value.length : utf8Length(value);
  if (size > max) {
    throw new BoundsError(
      "too_large",
      `${name} is ${size} ${
        byLength ? "characters" : "bytes"
      }, more than ${max}`,
    );
  }
  return value;
}

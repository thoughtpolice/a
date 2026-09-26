// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * The error every check in this package throws.
 *
 * @module
 */

/**
 * Why a value was refused:
 *
 * - `type`: not the kind of value asked for (a string where a number
 *   belongs, a used body, a non-byte chunk);
 * - `range`: `NaN`, an infinity, a fraction or unsafe integer where an
 *   integer belongs, or outside `min`/`max`;
 * - `too_large`: more bytes or characters than the cap;
 * - `too_many`: more items or keys than the cap;
 * - `too_deep`: nested deeper than the cap;
 * - `syntax`: not JSON;
 * - `duplicate_key`: a JSON object names a key twice;
 * - `forbidden_key`: a JSON object has `__proto__`, `constructor` or
 *   `prototype`.
 */
export type BoundsCode =
  | "type"
  | "range"
  | "too_large"
  | "too_many"
  | "too_deep"
  | "syntax"
  | "duplicate_key"
  | "forbidden_key";

/**
 * A refused value. It is a `RangeError`, so code that already catches
 * those keeps working; `code` says which check failed.
 */
export class BoundsError extends RangeError {
  override name = "BoundsError";
  readonly code: BoundsCode;

  constructor(code: BoundsCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.code = code;
  }
}

/** A short, bounded rendering of a refused value for messages. */
export function describe(value: unknown): string {
  if (typeof value === "string") {
    const text = value.length > 32 ? `${value.slice(0, 32)}…` : value;
    return JSON.stringify(text);
  }
  if (typeof value === "bigint") return `${value}n`;
  if (value === null) return "null";
  if (Array.isArray(value)) return "an array";
  if (typeof value === "object") return "an object";
  return String(value);
}

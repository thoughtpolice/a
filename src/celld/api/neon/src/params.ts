// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * Query parameters, encoded to the text Postgres reads.
 *
 * Neon's endpoint takes parameters as JSON and turns them into text for
 * Postgres itself, but its conversion of JSON arrays escapes strings the
 * JSON way, which is not Postgres's array syntax: an element `"a\nb"`
 * arrives as `anb`. So every parameter is encoded here, to a string (or
 * null), and Neon passes strings through untouched.
 *
 * @module
 */

/** A value that should be sent as JSON (for a `json`/`jsonb` parameter). */
export class Json {
  readonly value: unknown;
  constructor(value: unknown) {
    this.value = value;
  }
}

/** Marks `value` for a `json`/`jsonb` parameter, arrays included. */
export function json(value: unknown): Json {
  return new Json(value);
}

/** What a parameter may be. */
export type Param =
  | null
  | undefined
  | string
  | number
  | bigint
  | boolean
  | Date
  | Temporal.Instant
  | Temporal.ZonedDateTime
  | Temporal.PlainDate
  | Temporal.PlainDateTime
  | Temporal.PlainTime
  | Temporal.Duration
  | Uint8Array
  | ArrayBuffer
  | Json
  | readonly Param[]
  | { readonly [key: string]: unknown };

/** A parameter that cannot be encoded. */
export class ParamError extends TypeError {
  override readonly name = "ParamError";
}

function hex(bytes: Uint8Array): string {
  let out = "\\x";
  for (const byte of bytes) out += byte.toString(16).padStart(2, "0");
  return out;
}

/** The text of one parameter, or null for SQL NULL. */
export function encodeParam(value: unknown, path = "$"): string | null {
  switch (typeof value) {
    case "undefined":
      return null;
    case "string":
      if (value.includes("\0")) {
        throw new ParamError(`${path}: Postgres text cannot hold NUL`);
      }
      return value;
    case "number":
      return Object.is(value, -0) ? "0" : String(value);
    case "bigint":
      return value.toString();
    case "boolean":
      return value ? "true" : "false";
    case "object":
      break;
    default:
      throw new ParamError(`${path}: a ${typeof value} cannot be a parameter`);
  }
  if (value === null) return null;
  if (value instanceof Json) return JSON.stringify(value.value) ?? "null";
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) {
      throw new ParamError(`${path}: an invalid Date`);
    }
    return value.toISOString();
  }
  if (
    value instanceof Temporal.Instant || value instanceof Temporal.PlainDate ||
    value instanceof Temporal.PlainDateTime ||
    value instanceof Temporal.PlainTime ||
    value instanceof Temporal.Duration
  ) {
    return value.toString();
  }
  if (value instanceof Temporal.ZonedDateTime) {
    return value.toInstant().toString();
  }
  if (value instanceof Uint8Array) return hex(value);
  if (value instanceof ArrayBuffer) return hex(new Uint8Array(value));
  if (Array.isArray(value)) return arrayLiteral(value, path);
  const proto = Object.getPrototypeOf(value);
  if (proto === Object.prototype || proto === null) {
    return JSON.stringify(value);
  }
  throw new ParamError(
    `${path}: a ${
      proto?.constructor?.name ?? "object"
    } cannot be a parameter; wrap JSON in json()`,
  );
}

/** A Postgres array literal, each element quoted and escaped. */
export function arrayLiteral(items: readonly unknown[], path = "$"): string {
  const parts = items.map((item, i): string => {
    const where = `${path}[${i}]`;
    if (item === null || item === undefined) return "NULL";
    if (Array.isArray(item)) return arrayLiteral(item, where);
    const text = encodeParam(item, where)!;
    return `"${text.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
  });
  return `{${parts.join(",")}}`;
}

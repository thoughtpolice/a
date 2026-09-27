// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * Entity references and Cedar values, and their strict conversion to the
 * JSON Cedar reads.
 *
 * Cedar's JSON format overloads plain objects: a record whose only key is
 * `__entity` is an entity reference, and one with `__extn` an extension
 * value. A context or attribute built from caller data could therefore
 * smuggle a reference (`{"__entity": {"type": "Role", "id": "admin"}}`)
 * where a record was meant. {@link toCedarJson} refuses those keys in
 * records; references and extension values are made with {@link ref},
 * {@link ip}, {@link decimal}, {@link datetime} and {@link duration},
 * whose results it recognizes by class.
 *
 * Numbers must be safe integers: Cedar's `Long` is 64-bit, and values cross
 * into cedar-wasm through `JSON.stringify`, which cannot carry a larger
 * integer exactly nor any fraction Cedar would accept.
 *
 * @module
 */

import type { CedarValueJson, EntityUidJson } from "./ffi.ts";

/** A malformed value, uid or entity, found before anything reached Cedar. */
export class CedarValueError extends TypeError {
  override readonly name = "CedarValueError";
  /** Where in the value, as a dotted path (`context.owner.id`). */
  readonly path: string;
  constructor(path: string, message: string) {
    super(path ? `${path}: ${message}` : message);
    this.path = path;
  }
}

/** An entity's type (`User`, `Acme::Doc`) and id. */
export interface EntityUid {
  readonly type: string;
  readonly id: string;
}

const IDENT = /^[_a-zA-Z][_a-zA-Z0-9]*$/;

// Cedar's grammar reserves these; none can name a type.
const RESERVED = new Set([
  "true",
  "false",
  "if",
  "then",
  "else",
  "in",
  "is",
  "like",
  "has",
  "__cedar",
]);

/** Whether `name` is a valid entity type name (`User`, `Acme::Doc`). */
export function isTypeName(name: string): boolean {
  const parts = name.split("::");
  return parts.every((part) => IDENT.test(part) && !RESERVED.has(part));
}

/** An entity uid, checked and frozen. */
export function uid(type: string, id: string): EntityUid {
  if (typeof type !== "string" || !isTypeName(type)) {
    throw new CedarValueError(
      "",
      `${JSON.stringify(type)} is not an entity type name`,
    );
  }
  if (typeof id !== "string") {
    throw new CedarValueError("", "an entity id must be a string");
  }
  return Object.freeze({ type, id });
}

/** Whether two uids name the same entity. */
export function sameUid(a: EntityUid, b: EntityUid): boolean {
  return a.type === b.type && a.id === b.id;
}

/** The uid in Cedar syntax (`User::"alice"`), also a stable map key. */
export function formatUid(value: EntityUid): string {
  return `${value.type}::${quote(value.id)}`;
}

/** A Cedar string literal for `text`. */
export function quote(text: string): string {
  let out = '"';
  for (const char of text) {
    const code = char.codePointAt(0)!;
    switch (char) {
      case '"':
        out += '\\"';
        break;
      case "\\":
        out += "\\\\";
        break;
      case "\n":
        out += "\\n";
        break;
      case "\r":
        out += "\\r";
        break;
      case "\t":
        out += "\\t";
        break;
      case "\0":
        out += "\\0";
        break;
      default:
        out += code < 0x20 || code === 0x7f
          ? `\\u{${code.toString(16)}}`
          : char;
    }
  }
  return out + '"';
}

/** Parses `Type::"id"`, the inverse of {@link formatUid}. */
export function parseUid(text: string): EntityUid {
  const at = text.indexOf('::"');
  if (at <= 0 || !text.endsWith('"') || text.length < at + 4) {
    throw new CedarValueError(
      "",
      `${JSON.stringify(text)} is not an entity uid such as User::"alice"`,
    );
  }
  return uid(text.slice(0, at), unquote(text.slice(at + 2)));
}

/** The text of a Cedar string literal (with its quotes). */
export function unquote(literal: string): string {
  if (
    literal.length < 2 || literal[0] !== '"' ||
    literal[literal.length - 1] !== '"'
  ) {
    throw new CedarValueError("", "not a quoted Cedar string");
  }
  const body = literal.slice(1, -1);
  let out = "";
  for (let i = 0; i < body.length; i++) {
    const char = body[i];
    if (char === '"') {
      throw new CedarValueError("", "unescaped quote in a Cedar string");
    }
    if (char !== "\\") {
      out += char;
      continue;
    }
    const next = body[++i];
    switch (next) {
      case "n":
        out += "\n";
        break;
      case "r":
        out += "\r";
        break;
      case "t":
        out += "\t";
        break;
      case "0":
        out += "\0";
        break;
      case "\\":
      case '"':
      case "'":
        out += next;
        break;
      case "u": {
        const close = body.indexOf("}", i);
        const hex = body[i + 1] === "{" && close > i + 2
          ? body.slice(i + 2, close)
          : "";
        if (
          !/^[0-9a-fA-F]{1,6}$/.test(hex) || Number.parseInt(hex, 16) > 0x10ffff
        ) {
          throw new CedarValueError(
            "",
            "bad \\u{...} escape in a Cedar string",
          );
        }
        out += String.fromCodePoint(Number.parseInt(hex, 16));
        i = close;
        break;
      }
      default:
        throw new CedarValueError(
          "",
          `unknown escape \\${next ?? ""} in a Cedar string`,
        );
    }
  }
  return out;
}

/** Reads a uid from either of Cedar's JSON spellings. */
export function uidFromJson(value: EntityUidJson): EntityUid {
  const inner = "__entity" in value ? value.__entity : value;
  return uid(inner.type, inner.id);
}

/** A reference to an entity, as an attribute or context value. */
export class EntityRef {
  readonly uid: EntityUid;
  constructor(value: EntityUid) {
    this.uid = uid(value.type, value.id);
    Object.freeze(this);
  }
  toJSON(): CedarValueJson {
    return { __entity: { type: this.uid.type, id: this.uid.id } };
  }
}

/** An extension value: `ip`, `decimal`, `datetime` or `duration`. */
export class Extension {
  readonly fn: "ip" | "decimal" | "datetime" | "duration";
  readonly arg: string;
  constructor(fn: Extension["fn"], arg: string) {
    if (typeof arg !== "string") {
      throw new CedarValueError("", `${fn}() takes a string`);
    }
    this.fn = fn;
    this.arg = arg;
    Object.freeze(this);
  }
  toJSON(): CedarValueJson {
    return { __extn: { fn: this.fn, arg: this.arg } };
  }
}

/** A reference to the entity `type::id` (or a uid), as a value. */
export function ref(type: string | EntityUid, id?: string): EntityRef {
  if (typeof type === "string") {
    if (id === undefined) {
      throw new CedarValueError("", "ref(type, id) needs an id");
    }
    return new EntityRef(uid(type, id));
  }
  return new EntityRef(type);
}

/** An `ip` value: an IPv4 or IPv6 address or CIDR range. Cedar checks it. */
export function ip(text: string): Extension {
  return new Extension("ip", text);
}

/** A `decimal` value: up to four fractional digits, as Cedar parses it. */
export function decimal(text: string): Extension {
  return new Extension("decimal", text);
}

/**
 * A `datetime` value, from Cedar's own text (`2026-09-26`,
 * `2026-09-26T12:00:00Z`, with optional milliseconds and `+hhmm` offset),
 * a `Temporal.Instant` or `ZonedDateTime`, or a valid `Date`.
 */
export function datetime(
  value: string | Temporal.Instant | Temporal.ZonedDateTime | Date,
): Extension {
  if (typeof value === "string") return new Extension("datetime", value);
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) {
      throw new CedarValueError("", "datetime() of an invalid Date");
    }
    return new Extension("datetime", value.toISOString());
  }
  const instant = value instanceof Temporal.ZonedDateTime
    ? value.toInstant()
    : value;
  return new Extension(
    "datetime",
    instant.toString({ smallestUnit: "millisecond" }),
  );
}

/**
 * A `duration` value, from Cedar's text (`1d2h3m4s5ms`, optionally
 * negative) or a `Temporal.Duration` of days and smaller units (years,
 * months and weeks have no fixed length, so they are refused).
 */
export function duration(value: string | Temporal.Duration): Extension {
  if (typeof value === "string") return new Extension("duration", value);
  if (value.years !== 0 || value.months !== 0 || value.weeks !== 0) {
    throw new CedarValueError(
      "",
      "duration() needs a Temporal.Duration without years, months or weeks",
    );
  }
  const ms = value.total({ unit: "milliseconds" });
  if (!Number.isSafeInteger(ms)) {
    throw new CedarValueError(
      "",
      "duration() of a fraction of a millisecond or out of range",
    );
  }
  return new Extension("duration", `${ms}ms`);
}

/**
 * What converts to a Cedar value: booleans, safe integers, strings,
 * {@link EntityRef}s, {@link Extension}s, `Temporal.Instant` and
 * `ZonedDateTime` (datetime), `Temporal.Duration` (duration), arrays
 * (sets) and plain objects (records, whose `undefined` fields are left out).
 */
export type CedarInput =
  | boolean
  | number
  | bigint
  | string
  | EntityRef
  | Extension
  | Temporal.Instant
  | Temporal.ZonedDateTime
  | Temporal.Duration
  | readonly CedarInput[]
  | { readonly [key: string]: CedarInput | undefined };

/** Limits for {@link toCedarJson}. */
export interface ValueLimits {
  /** Nesting of sets and records (default 32; cedar-wasm's parser stops at 128 for a whole call). */
  readonly maxDepth?: number;
}

export const DEFAULT_MAX_DEPTH = 32;

const LONG_MAX = 2n ** 63n - 1n;
const LONG_MIN = -(2n ** 63n);

/** Converts `value` to Cedar JSON, or throws a {@link CedarValueError}. */
export function toCedarJson(
  value: CedarInput,
  limits: ValueLimits = {},
  path = "",
): CedarValueJson {
  return convert(value, limits.maxDepth ?? DEFAULT_MAX_DEPTH, path);
}

function convert(value: unknown, depth: number, path: string): CedarValueJson {
  switch (typeof value) {
    case "boolean":
    case "string":
      return value;
    case "number":
      if (!Number.isSafeInteger(value)) {
        throw new CedarValueError(
          path,
          `${value} is not a safe integer; Cedar has only 64-bit integers (use decimal() for fractions)`,
        );
      }
      return Object.is(value, -0) ? 0 : value;
    case "bigint":
      if (value > LONG_MAX || value < LONG_MIN) {
        throw new CedarValueError(path, "out of Cedar's 64-bit range");
      }
      if (
        value > BigInt(Number.MAX_SAFE_INTEGER) ||
        value < BigInt(Number.MIN_SAFE_INTEGER)
      ) {
        throw new CedarValueError(
          path,
          "a bigint past 2^53 cannot cross into cedar-wasm exactly",
        );
      }
      return Number(value);
    case "object":
      break;
    default:
      throw new CedarValueError(path, `a ${typeof value} is not a Cedar value`);
  }
  if (value === null) {
    throw new CedarValueError(
      path,
      "Cedar has no null; leave the attribute out",
    );
  }
  if (value instanceof EntityRef || value instanceof Extension) {
    return value.toJSON();
  }
  if (
    value instanceof Temporal.Instant || value instanceof Temporal.ZonedDateTime
  ) return datetime(value).toJSON();
  if (value instanceof Temporal.Duration) return duration(value).toJSON();
  if (value instanceof Date) return datetime(value).toJSON();
  if (depth <= 0) throw new CedarValueError(path, "nested too deeply");
  if (Array.isArray(value)) {
    return value.map((item, i) => convert(item, depth - 1, `${path}[${i}]`));
  }
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) {
    throw new CedarValueError(
      path,
      `a ${
        proto?.constructor?.name ?? "non-plain object"
      } is not a Cedar value; use a plain object, array, ref() or an extension`,
    );
  }
  const out: Record<string, CedarValueJson> = {};
  for (const key of Object.keys(value)) {
    const where = path ? `${path}.${key}` : key;
    if (key === "__entity" || key === "__extn") {
      throw new CedarValueError(
        where,
        "records may not use Cedar's escape keys; make references with ref()",
      );
    }
    const field = (value as Record<string, unknown>)[key];
    if (field === undefined) continue;
    Object.defineProperty(out, key, {
      value: convert(field, depth - 1, where),
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  return out;
}

/** A value read back from Cedar JSON: references and extensions as classes. */
export type CedarValue =
  | boolean
  | number
  | string
  | EntityRef
  | Extension
  | readonly CedarValue[]
  | { readonly [key: string]: CedarValue };

/** Reads Cedar JSON (an attribute, a residual's value) into values. */
export function fromCedarJson(json: CedarValueJson, path = ""): CedarValue {
  if (json === null) throw new CedarValueError(path, "Cedar has no null");
  if (typeof json !== "object") return json;
  if (Array.isArray(json)) {
    return json.map((item, i) => fromCedarJson(item, `${path}[${i}]`));
  }
  const keys = Object.keys(json);
  const record = json as Record<string, CedarValueJson>;
  if (keys.length === 1 && keys[0] === "__entity") {
    return new EntityRef(uidFromJson(record as unknown as EntityUidJson));
  }
  if (keys.length === 1 && keys[0] === "__extn") {
    const extn = record.__extn as {
      fn: string;
      arg?: unknown;
      args?: unknown[];
    };
    const arg = extn.arg ?? extn.args?.[0];
    if (
      !["ip", "decimal", "datetime", "duration"].includes(extn.fn) ||
      typeof arg !== "string"
    ) {
      throw new CedarValueError(
        path,
        `unsupported extension value ${JSON.stringify(extn)}`,
      );
    }
    return new Extension(extn.fn as Extension["fn"], arg);
  }
  const out: Record<string, CedarValue> = {};
  for (const key of keys) {
    Object.defineProperty(out, key, {
      value: fromCedarJson(record[key], path ? `${path}.${key}` : key),
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  return out;
}

/** The JSON Cedar takes for a uid. */
export function uidJson(value: EntityUid): EntityUidJson {
  return { type: value.type, id: value.id };
}

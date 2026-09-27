// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * Postgres values in text format, read into JavaScript.
 *
 * The client asks Neon for raw text output (`Neon-Raw-Text-Output`), so
 * every value arrives as Postgres printed it, and is parsed here by the
 * column's type OID. That keeps what JSON would lose: an `int8` past 2^53
 * reads as a `bigint`, a `numeric` keeps every digit as a string, and dates
 * and times become `Temporal` values. Types without a parser stay strings.
 *
 * @module
 */

/** Type OIDs of the built-in types this module reads. */
export const OID = Object.freeze({
  bool: 16,
  bytea: 17,
  char: 18,
  name: 19,
  int8: 20,
  int2: 21,
  int4: 23,
  text: 25,
  oid: 26,
  json: 114,
  xml: 142,
  cidr: 650,
  float4: 700,
  float8: 701,
  money: 790,
  inet: 869,
  bpchar: 1042,
  varchar: 1043,
  date: 1082,
  time: 1083,
  timestamp: 1114,
  timestamptz: 1184,
  interval: 1186,
  timetz: 1266,
  bit: 1560,
  varbit: 1562,
  numeric: 1700,
  uuid: 2950,
  jsonb: 3802,
  // Arrays of the above.
  _bool: 1000,
  _bytea: 1001,
  _char: 1002,
  _name: 1003,
  _int2: 1005,
  _int4: 1007,
  _text: 1009,
  _bpchar: 1014,
  _varchar: 1015,
  _int8: 1016,
  _float4: 1021,
  _float8: 1022,
  _oid: 1028,
  _inet: 1041,
  _cidr: 651,
  _json: 199,
  _time: 1183,
  _timestamp: 1115,
  _date: 1182,
  _timestamptz: 1185,
  _interval: 1187,
  _numeric: 1231,
  _uuid: 2951,
  _jsonb: 3807,
});

/** Parses one value's text. */
export type Parser = (text: string) => unknown;

/** How values are read. */
export interface TypeOptions {
  /** `int8`: `bigint` (default), exact `string`, or `number` (throws past 2^53). */
  readonly int8?: "bigint" | "string" | "number";
  /** `numeric`: exact `string` (default) or `number` (may round). */
  readonly numeric?: "string" | "number";
  /**
   * Dates and times as `Temporal` values (default) or as Postgres printed
   * them. `infinity`, `-infinity` and BC dates stay strings either way.
   */
  readonly temporal?: boolean;
  /** Parsers by type OID, over the defaults (an enum's or a domain's, say). */
  readonly parsers?: { readonly [oid: number]: Parser };
}

/** A malformed value in a response. */
export class ValueParseError extends Error {
  override readonly name = "ValueParseError";
}

function bool(text: string): boolean {
  if (text === "t") return true;
  if (text === "f") return false;
  throw new ValueParseError(`not a boolean: ${JSON.stringify(text)}`);
}

function int(text: string): number {
  const value = Number(text);
  if (!Number.isSafeInteger(value)) {
    throw new ValueParseError(`not an integer: ${JSON.stringify(text)}`);
  }
  return value;
}

function float(text: string): number {
  // Postgres prints NaN, Infinity and -Infinity, which Number reads.
  const value = Number(text);
  if (Number.isNaN(value) && text !== "NaN") {
    throw new ValueParseError(`not a number: ${JSON.stringify(text)}`);
  }
  return value;
}

function int8(mode: TypeOptions["int8"]): Parser {
  switch (mode ?? "bigint") {
    case "bigint":
      return (text) => BigInt(text);
    case "string":
      return (text) => text;
    case "number":
      return (text) => {
        const value = Number(text);
        if (!Number.isSafeInteger(value)) {
          throw new ValueParseError(
            `int8 ${text} does not fit a number; read int8 as "bigint" or "string"`,
          );
        }
        return value;
      };
  }
}

/** `\x0a1b...` (hex output, the default since Postgres 9.0) to bytes. */
export function parseBytea(text: string): Uint8Array {
  if (!text.startsWith("\\x") || text.length % 2 !== 0) {
    throw new ValueParseError(
      "bytea is not in hex format (set bytea_output = hex)",
    );
  }
  const out = new Uint8Array((text.length - 2) / 2);
  for (let i = 0; i < out.length; i++) {
    const byte = Number.parseInt(text.slice(2 + i * 2, 4 + i * 2), 16);
    if (Number.isNaN(byte)) {
      throw new ValueParseError("bytea has a non-hex digit");
    }
    out[i] = byte;
  }
  return out;
}

const SPECIAL = new Set(["infinity", "-infinity"]);

/** Whether Postgres printed a value Temporal cannot hold. */
function special(text: string): boolean {
  return SPECIAL.has(text) || text.endsWith(" BC");
}

/**
 * `2026-09-27 02:03:06.032994+00` (ISO DateStyle) to an Instant. Postgres
 * writes the offset as `+HH`, `+HH:MM` or `+HH:MM:SS`.
 */
export function parseTimestamptz(text: string): Temporal.Instant | string {
  if (special(text)) return text;
  const match =
    /^(\d{4,}-\d\d-\d\d) (\d\d:\d\d:\d\d(?:\.\d+)?)([+-]\d\d)(?::(\d\d))?(?::(\d\d))?$/
      .exec(text);
  if (match === null) {
    throw new ValueParseError(
      `not a timestamptz in ISO format: ${JSON.stringify(text)}`,
    );
  }
  const [, date, time, hours, minutes = "00", seconds] = match;
  const offset = `${hours}:${minutes}${seconds ? `:${seconds}` : ""}`;
  return Temporal.Instant.from(`${date}T${time}${offset}`);
}

export function parseTimestamp(text: string): Temporal.PlainDateTime | string {
  return special(text)
    ? text
    : Temporal.PlainDateTime.from(text.replace(" ", "T"));
}

export function parseDate(text: string): Temporal.PlainDate | string {
  return special(text) ? text : Temporal.PlainDate.from(text);
}

export function parseTime(text: string): Temporal.PlainTime {
  return Temporal.PlainTime.from(text);
}

/**
 * Parses an array literal (`{1,NULL,"a,b"}`, nested `{{1,2},{3,4}}`, with
 * an optional `[1:2]=` bounds prefix) applying `element` to each item.
 */
export function parseArray(text: string, element: Parser): unknown[] {
  let i = 0;
  if (text[0] === "[") {
    const eq = text.indexOf("=");
    if (eq < 0) throw new ValueParseError("array bounds without '='");
    i = eq + 1;
  }
  const fail = (why: string): never => {
    throw new ValueParseError(
      `malformed array (${why}) at ${i}: ${JSON.stringify(text.slice(0, 80))}`,
    );
  };
  const parse = (): unknown[] => {
    if (text[i] !== "{") fail("expected '{'");
    i++;
    const out: unknown[] = [];
    if (text[i] === "}") {
      i++;
      return out;
    }
    for (;;) {
      if (text[i] === "{") {
        out.push(parse());
      } else if (text[i] === '"') {
        i++;
        let value = "";
        while (text[i] !== '"') {
          if (i >= text.length) fail("unterminated quote");
          if (text[i] === "\\") i++;
          value += text[i++];
        }
        i++;
        out.push(element(value));
      } else {
        const start = i;
        while (i < text.length && text[i] !== "," && text[i] !== "}") i++;
        const raw = text.slice(start, i).trim();
        out.push(raw === "NULL" ? null : element(raw));
      }
      if (text[i] === ",") {
        i++;
        continue;
      }
      if (text[i] === "}") {
        i++;
        return out;
      }
      fail("expected ',' or '}'");
    }
  };
  const result = parse();
  if (i !== text.length) fail("trailing text");
  return result;
}

/** The parser for each OID under `options`. */
export function parsers(
  options: TypeOptions = {},
): ReadonlyMap<number, Parser> {
  const temporal = options.temporal ?? true;
  const text = (s: string) => s;
  const numeric: Parser = options.numeric === "number" ? float : text;
  const base: [number, Parser][] = [
    [OID.bool, bool],
    [OID.bytea, parseBytea],
    [OID.int2, int],
    [OID.int4, int],
    [OID.oid, int],
    [OID.int8, int8(options.int8)],
    [OID.float4, float],
    [OID.float8, float],
    [OID.numeric, numeric],
    [OID.json, (s) => JSON.parse(s)],
    [OID.jsonb, (s) => JSON.parse(s)],
  ];
  if (temporal) {
    base.push(
      [OID.date, parseDate],
      [OID.time, parseTime],
      [OID.timestamp, parseTimestamp],
      [OID.timestamptz, parseTimestamptz],
    );
  }
  const map = new Map<number, Parser>(base);
  const arrays: [number, number][] = [
    [OID._bool, OID.bool],
    [OID._bytea, OID.bytea],
    [OID._int2, OID.int2],
    [OID._int4, OID.int4],
    [OID._oid, OID.oid],
    [OID._int8, OID.int8],
    [OID._float4, OID.float4],
    [OID._float8, OID.float8],
    [OID._numeric, OID.numeric],
    [OID._json, OID.json],
    [OID._jsonb, OID.jsonb],
    [OID._date, OID.date],
    [OID._time, OID.time],
    [OID._timestamp, OID.timestamp],
    [OID._timestamptz, OID.timestamptz],
    [OID._text, OID.text],
    [OID._varchar, OID.varchar],
    [OID._bpchar, OID.bpchar],
    [OID._name, OID.name],
    [OID._char, OID.char],
    [OID._uuid, OID.uuid],
    [OID._inet, OID.inet],
    [OID._cidr, OID.cidr],
    [OID._interval, OID.interval],
  ];
  for (const [oid, parser] of Object.entries(options.parsers ?? {})) {
    if (typeof parser !== "function") {
      throw new TypeError(`the parser for OID ${oid} is not a function`);
    }
    map.set(Number(oid), parser);
  }
  for (const [array, element] of arrays) {
    if (map.has(array)) continue;
    const item = map.get(element) ?? text;
    map.set(array, (s) => parseArray(s, item));
  }
  return map;
}

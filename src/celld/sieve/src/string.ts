// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * {@link StringSchema}: length and pattern checks, the string formats
 * (`email`, `url`, `uuid`, `datetime`, `jwt`, `cidrv4`, ...), and the
 * `trim` and case rewrites, which run in order with the checks, and the
 * conversions to `Temporal` values (`toInstant`, `toDuration`, ...).
 *
 * @module
 */

import type {
  FormatCheck,
  StringDef,
  StringFormat,
  TemporalType,
} from "./def.ts";
import { type Message, messageField, type Path } from "./errors.ts";
import {
  type Context,
  invalidType,
  ok,
  PipeSchema,
  type Result,
  Schema,
} from "./schema.ts";
import { TemporalSchema } from "./temporal.ts";

/**
 * Options for `.datetime()`. By default only `Z` is accepted as the zone
 * and seconds and fractions are optional.
 */
export interface DatetimeOptions {
  /** Also accept a `±HH:MM` offset. */
  readonly offset?: boolean;
  /** Also accept no zone at all. */
  readonly local?: boolean;
  /**
   * `-1` for minutes only, `0` for whole seconds, `n` for exactly `n`
   * fractional digits; absent, seconds are optional and fractions any length.
   */
  readonly precision?: number;
  readonly message?: string;
}

/** Options for `.isoTime()`: `precision` as for {@link DatetimeOptions}. */
export interface TimeOptions {
  readonly precision?: number;
  readonly message?: string;
}

/** Options for `.jwt()`. */
export interface JwtOptions {
  /** The header's `alg` must be this. */
  readonly alg?: string;
  readonly message?: string;
}

function spec<T extends { readonly message?: string }>(
  options: string | T | undefined,
): Partial<T> {
  return typeof options === "string"
    ? { message: options } as Partial<T>
    : options ?? {};
}

/** A string; `v.coerce.string()` accepts anything and applies `String`. */
export class StringSchema<I = string> extends Schema<string, I> {
  declare readonly def: StringDef;

  protected "~parse"(input: unknown, path: Path, _context: Context): Result {
    let value = input;
    if (this.def.coerce) {
      try {
        value = String(input);
      } catch {
        return invalidType(path, "string", input, this.def.message);
      }
    }
    return typeof value === "string"
      ? ok(value)
      : invalidType(path, "string", input, this.def.message);
  }

  protected format(format: StringFormat, message?: Message): this {
    return this.addCheck({ check: "format", format, ...messageField(message) });
  }

  /** At least `length` UTF-16 code units. */
  min(length: number, message?: Message): this {
    return this.addCheck({
      check: "min_length",
      value: length,
      ...messageField(message),
    });
  }

  /** At most `length` UTF-16 code units. */
  max(length: number, message?: Message): this {
    return this.addCheck({
      check: "max_length",
      value: length,
      ...messageField(message),
    });
  }

  /** Exactly `length` UTF-16 code units. */
  length(length: number, message?: Message): this {
    return this.addCheck({
      check: "length",
      value: length,
      ...messageField(message),
    });
  }

  /** Not empty: `min(1)`. */
  nonempty(message?: Message): this {
    return this.min(1, message);
  }

  /** Matches `pattern` (anchor it yourself). */
  regex(pattern: RegExp, message?: Message): this {
    return this.addCheck({ check: "regex", pattern, ...messageField(message) });
  }

  /** Starts with `prefix`. */
  startsWith(prefix: string, message?: Message): this {
    return this.addCheck({
      check: "starts_with",
      value: prefix,
      ...messageField(message),
    });
  }

  /** Ends with `suffix`. */
  endsWith(suffix: string, message?: Message): this {
    return this.addCheck({
      check: "ends_with",
      value: suffix,
      ...messageField(message),
    });
  }

  /** Contains `part`. */
  includes(part: string, message?: Message): this {
    return this.addCheck({
      check: "includes",
      value: part,
      ...messageField(message),
    });
  }

  /** A plain `local@domain.tld` address; no quoted local parts or IP domains. */
  email(message?: Message): this {
    return this.format("email", message);
  }

  /** Anything `new URL` accepts, with any scheme. */
  url(message?: Message): this {
    return this.format("url", message);
  }

  /** An RFC 9562 UUID (versions 1-8), or the nil or max UUID. */
  uuid(message?: Message): this {
    return this.format("uuid", message);
  }

  /** An ISO 8601 date and time; see {@link DatetimeOptions}. */
  datetime(options?: string | DatetimeOptions): this {
    const given = spec(options);
    const check: FormatCheck = {
      check: "format",
      format: "datetime",
      ...(given.offset ? { offset: true } : {}),
      ...(given.local ? { local: true } : {}),
      ...(given.precision === undefined ? {} : { precision: given.precision }),
      ...(given.message === undefined ? {} : { message: given.message }),
    };
    return this.addCheck(check);
  }

  /** An ISO 8601 calendar date, `YYYY-MM-DD`, that exists. */
  isoDate(message?: Message): this {
    return this.format("date", message);
  }

  /**
   * An ISO 8601 time of day, `HH:MM[:SS[.f]]`, with no zone (as zod's
   * `iso.time`); see {@link TimeOptions}.
   */
  isoTime(options?: string | TimeOptions): this {
    const given = spec(options);
    const check: FormatCheck = {
      check: "format",
      format: "time",
      ...(given.precision === undefined ? {} : { precision: given.precision }),
      ...(given.message === undefined ? {} : { message: given.message }),
    };
    return this.addCheck(check);
  }

  /** An ISO 8601 duration, `PnYnMnDTnHnMnS` or `PnW`. */
  isoDuration(message?: Message): this {
    return this.format("duration", message);
  }

  /** Padded standard base64. */
  base64(message?: Message): this {
    return this.format("base64", message);
  }

  /** Unpadded URL-safe base64. */
  base64url(message?: Message): this {
    return this.format("base64url", message);
  }

  /** Hex digits, any case, any length. */
  hex(message?: Message): this {
    return this.format("hex", message);
  }

  /** A dotted-quad IPv4 address. */
  ipv4(message?: Message): this {
    return this.format("ipv4", message);
  }

  /** An IPv6 address, including `::` and an embedded IPv4 tail. */
  ipv6(message?: Message): this {
    return this.format("ipv6", message);
  }

  /** An IPv4 CIDR block, such as `10.0.0.0/8`; host bits may be set. */
  cidrv4(message?: Message): this {
    return this.format("cidrv4", message);
  }

  /** An IPv6 CIDR block, such as `2001:db8::/32`; host bits may be set. */
  cidrv6(message?: Message): this {
    return this.format("cidrv6", message);
  }

  /** A ULID, in either case. */
  ulid(message?: Message): this {
    return this.format("ulid", message);
  }

  /**
   * A JWT's shape: a compact JWS whose header and payload are JSON objects
   * (see `isJwt` in `@celld/jwt`). The signature is not verified; that
   * takes a key and `verify` from `@celld/jwt`.
   */
  jwt(options?: string | JwtOptions): this {
    const given = spec(options);
    const check: FormatCheck = {
      check: "format",
      format: "jwt",
      ...(given.alg === undefined ? {} : { alg: given.alg }),
      ...(given.message === undefined ? {} : { message: given.message }),
    };
    return this.addCheck(check);
  }

  /** Trims whitespace; checks after this see the trimmed value. */
  trim(): this {
    return this.addCheck({ check: "trim" });
  }

  /** Lower-cases the value; checks after this see the result. */
  toLowerCase(): this {
    return this.addCheck({ check: "to_lower_case" });
  }

  /** Upper-cases the value; checks after this see the result. */
  toUpperCase(): this {
    return this.addCheck({ check: "to_upper_case" });
  }

  protected toTemporal<T>(
    type: TemporalType,
    message?: Message,
  ): PipeSchema<this, TemporalSchema<T, string>> {
    return this.pipe(
      new TemporalSchema<T, string>({
        kind: "temporal",
        type,
        coerce: true,
        checks: [],
        ...messageField(message),
      }),
    );
  }

  /**
   * Converts the string, once it passes this schema, to a
   * `Temporal.Instant`. It must be an RFC 3339 date-time with `Z` or an
   * offset, read strictly by `@celld/isotime`; put `.datetime({ offset:
   * true, precision })` first for zod's options and messages.
   */
  toInstant(
    message?: Message,
  ): PipeSchema<this, TemporalSchema<Temporal.Instant, string>> {
    return this.toTemporal("instant", message);
  }

  /**
   * Converts the string to a `Temporal.PlainDateTime`: a date-time with no
   * zone (text with `Z` or an offset is refused, not stripped).
   */
  toPlainDateTime(
    message?: Message,
  ): PipeSchema<this, TemporalSchema<Temporal.PlainDateTime, string>> {
    return this.toTemporal("plain_date_time", message);
  }

  /** Converts the string, a calendar date, to a `Temporal.PlainDate`. */
  toPlainDate(
    message?: Message,
  ): PipeSchema<this, TemporalSchema<Temporal.PlainDate, string>> {
    return this.toTemporal("plain_date", message);
  }

  /** Converts the string, a time of day with no zone, to a `Temporal.PlainTime`. */
  toPlainTime(
    message?: Message,
  ): PipeSchema<this, TemporalSchema<Temporal.PlainTime, string>> {
    return this.toTemporal("plain_time", message);
  }

  /** Converts the string, an ISO 8601 duration, to a `Temporal.Duration`. */
  toDuration(
    message?: Message,
  ): PipeSchema<this, TemporalSchema<Temporal.Duration, string>> {
    return this.toTemporal("duration", message);
  }
}

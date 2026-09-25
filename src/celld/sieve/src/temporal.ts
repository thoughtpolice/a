// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * {@link TemporalSchema}: `Temporal` values, and the strict conversions
 * from ISO 8601 strings to them that `StringSchema`'s `toInstant`,
 * `toPlainDate`, ... pipe into.
 *
 * @module
 */

import {
  parseDate,
  parseDateTime,
  parseDuration,
  parseLocalDateTime,
  parseTime,
} from "@celld/isotime";
import type { StringFormat, TemporalDef, TemporalType } from "./def.ts";
import { makeIssue, type Path } from "./errors.ts";
import {
  type Context,
  invalidType,
  ok,
  type Result,
  Schema,
} from "./schema.ts";

interface TypeInfo {
  readonly name: string;
  readonly is: (value: unknown) => boolean;
  /** The string form a conversion reads, and its strict parser. */
  readonly text?: {
    readonly format: StringFormat;
    readonly parse: (text: string) => unknown;
  };
}

const TYPES: Readonly<Record<TemporalType, TypeInfo>> = {
  instant: {
    name: "Temporal.Instant",
    is: (value) => value instanceof Temporal.Instant,
    text: {
      format: "datetime",
      parse: (text) => parseDateTime(text, { offset: true }),
    },
  },
  zoned_date_time: {
    name: "Temporal.ZonedDateTime",
    is: (value) => value instanceof Temporal.ZonedDateTime,
  },
  plain_date: {
    name: "Temporal.PlainDate",
    is: (value) => value instanceof Temporal.PlainDate,
    text: { format: "date", parse: parseDate },
  },
  plain_time: {
    name: "Temporal.PlainTime",
    is: (value) => value instanceof Temporal.PlainTime,
    text: { format: "time", parse: (text) => parseTime(text) },
  },
  plain_date_time: {
    name: "Temporal.PlainDateTime",
    is: (value) => value instanceof Temporal.PlainDateTime,
    text: { format: "datetime", parse: (text) => parseLocalDateTime(text) },
  },
  duration: {
    name: "Temporal.Duration",
    is: (value) => value instanceof Temporal.Duration,
    text: { format: "duration", parse: parseDuration },
  },
};

/** The string format a conversion to `type` reads, if it has one. */
export function temporalFormat(type: TemporalType): StringFormat | undefined {
  return TYPES[type].text?.format;
}

/**
 * A `Temporal` value of one type (`v.instant()`, `v.duration()`, ...). A
 * conversion (`v.iso.datetime().toInstant()`) takes a string instead and
 * parses it with `@celld/isotime`: an instant from a date-time with `Z` or
 * an offset, a plain date-time from one with no zone, a plain time from a
 * time with no zone, a plain date, or a duration. Text they refuse is an
 * `invalid_format` issue.
 */
export class TemporalSchema<T, I = T> extends Schema<T, I> {
  declare readonly def: TemporalDef;

  protected "~parse"(input: unknown, path: Path, _context: Context): Result {
    const type = TYPES[this.def.type];
    if (!this.def.coerce || type.text === undefined) {
      return type.is(input)
        ? ok(input)
        : invalidType(path, type.name, input, this.def.message);
    }
    if (typeof input !== "string") {
      return invalidType(path, "string", input, this.def.message);
    }
    const value = type.text.parse(input);
    if (value !== null) return ok(value);
    return {
      value: input,
      issues: [
        makeIssue(
          path,
          { code: "invalid_format", format: type.text.format },
          this.def.message,
        ),
      ],
      aborted: true,
    };
  }
}

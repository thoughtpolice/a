// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * Strict RFC 3339 dates, times of day and date-times, checked here and
 * handed to `Temporal` once they pass.
 *
 * @module
 */

/**
 * How many digits of seconds a time must have, as zod 4's `precision`:
 * `-1` for minutes only (`HH:MM`), `0` for whole seconds, `n` for exactly
 * `n` fractional digits. Absent, seconds are optional and a fraction may
 * have any number of digits.
 */
export interface PrecisionOptions {
  readonly precision?: number;
}

/**
 * Options for times of day. `zone` says whether the text may end in `Z` or
 * `±HH:MM`: `"none"` (the default, as zod's `iso.time`) forbids one,
 * `"required"` needs one (RFC 3339's `full-time`), `"any"` takes either.
 */
export interface TimeOptions extends PrecisionOptions {
  readonly zone?: "none" | "required" | "any";
}

/**
 * Options for date-times, as zod 4's `iso.datetime`: `Z` is always
 * accepted, `offset` also accepts `±HH:MM`, and `local` also accepts no
 * zone at all.
 */
export interface DateTimeOptions extends PrecisionOptions {
  readonly offset?: boolean;
  readonly local?: boolean;
}

/** {@link DateTimeOptions} that require a zone, so the text names an instant. */
export interface ZonedDateTimeOptions extends DateTimeOptions {
  readonly local?: false;
}

/** {@link DateTimeOptions} that also accept a local date-time. */
export interface LocalDateTimeOptions extends DateTimeOptions {
  readonly local: true;
}

const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const YEAR_MONTH = /^(\d{4})-(\d{2})$/;
const TIME =
  /^(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d+))?)?(Z|([+-])(\d{2}):(\d{2}))?$/;

type Zone = "none" | "required" | "any";

interface Clock {
  readonly time: Temporal.PlainTime;
  /** `±HH:MM`, `+00:00` for `Z`; absent for a local time. */
  readonly offset?: string;
}

function date(text: string): Temporal.PlainDate | null {
  const match = DATE.exec(text);
  if (match === null) return null;
  try {
    return Temporal.PlainDate.from(
      { year: +match[1], month: +match[2], day: +match[3] },
      { overflow: "reject" },
    );
  } catch {
    return null;
  }
}

function clock(
  text: string,
  precision: number | undefined,
  zone: Zone,
  offsets: boolean,
): Clock | null {
  const match = TIME.exec(text);
  if (match === null) return null;
  const [, hh, mm, ss, fraction, designator, sign, oh, om] = match;
  if (+hh > 23 || +mm > 59) return null;
  if (ss !== undefined && +ss > 59) return null;
  if (precision !== undefined) {
    if (precision < 0 ? ss !== undefined : ss === undefined) return null;
    if ((fraction?.length ?? 0) !== Math.max(precision, 0)) return null;
  }
  let offset: string | undefined;
  if (designator === "Z") {
    offset = "+00:00";
  } else if (designator !== undefined) {
    if (!offsets || +oh > 23 || +om > 59) return null;
    // RFC 3339's `-00:00` ("offset unknown") is the same instant as `Z`.
    offset = `${+oh + +om === 0 ? "+" : sign}${oh}:${om}`;
  }
  if (
    zone === "none"
      ? offset !== undefined
      : zone === "required" && offset === undefined
  ) {
    return null;
  }
  // Digits past nanoseconds are cut off, as Temporal cannot hold them.
  const nanos = (fraction ?? "").slice(0, 9).padEnd(9, "0");
  const time = Temporal.PlainTime.from({
    hour: +hh,
    minute: +mm,
    second: ss === undefined ? 0 : +ss,
    millisecond: +nanos.slice(0, 3),
    microsecond: +nanos.slice(3, 6),
    nanosecond: +nanos.slice(6, 9),
  });
  return offset === undefined ? { time } : { time, offset };
}

/**
 * A month of a year, `YYYY-MM` (RFC 3339's `date-fullyear "-" date-month`),
 * as a `Temporal.PlainYearMonth`; null otherwise.
 */
export function parseYearMonth(text: string): Temporal.PlainYearMonth | null {
  const match = YEAR_MONTH.exec(text);
  if (match === null || +match[2] < 1 || +match[2] > 12) return null;
  return Temporal.PlainYearMonth.from({ year: +match[1], month: +match[2] });
}

/** A calendar date, `YYYY-MM-DD`, that exists; null otherwise. */
export function parseDate(text: string): Temporal.PlainDate | null {
  return date(text);
}

/**
 * A time of day, `HH:MM[:SS[.f]]` and a zone per `options`; null otherwise.
 * A zone is checked but not kept, since a `PlainTime` has none; digits past
 * nanoseconds are cut off.
 */
export function parseTime(
  text: string,
  options: TimeOptions = {},
): Temporal.PlainTime | null {
  return clock(text, options.precision, options.zone ?? "none", true)?.time ??
    null;
}

/**
 * A date-time, `YYYY-MM-DDTHH:MM[:SS[.f]]` and a zone per `options`; null
 * otherwise. `T` and `Z` must be upper case, and leap seconds (`:60`) are
 * rejected. Text with a zone is a `Temporal.Instant`; with `local: true`,
 * text without one is a `Temporal.PlainDateTime`. Digits past nanoseconds
 * are cut off.
 */
export function parseDateTime(
  text: string,
  options?: ZonedDateTimeOptions,
): Temporal.Instant | null;
export function parseDateTime(
  text: string,
  options: LocalDateTimeOptions,
): Temporal.Instant | Temporal.PlainDateTime | null;
export function parseDateTime(
  text: string,
  options?: DateTimeOptions,
): Temporal.Instant | Temporal.PlainDateTime | null;
export function parseDateTime(
  text: string,
  options: DateTimeOptions = {},
): Temporal.Instant | Temporal.PlainDateTime | null {
  const cut = text.indexOf("T");
  if (cut < 0) return null;
  const day = date(text.slice(0, cut));
  if (day === null) return null;
  const at = clock(
    text.slice(cut + 1),
    options.precision,
    options.local ? "any" : "required",
    options.offset === true,
  );
  if (at === null) return null;
  const local = day.toPlainDateTime(at.time);
  return at.offset === undefined
    ? local
    : local.toZonedDateTime(at.offset).toInstant();
}

/**
 * A date-time that must have no zone, as a `Temporal.PlainDateTime`; null
 * otherwise (including for text with `Z` or an offset).
 */
export function parseLocalDateTime(
  text: string,
  options: PrecisionOptions = {},
): Temporal.PlainDateTime | null {
  const parsed = parseDateTime(text, { ...options, local: true });
  return parsed instanceof Temporal.PlainDateTime ? parsed : null;
}

/** Whether `text` is a calendar date that exists. */
export function isDate(text: string): boolean {
  return date(text) !== null;
}

/** Whether `text` is a month of a year, `YYYY-MM`. */
export function isYearMonth(text: string): boolean {
  return parseYearMonth(text) !== null;
}

/** Whether `text` is a time of day; see {@link TimeOptions}. */
export function isTime(text: string, options: TimeOptions = {}): boolean {
  return parseTime(text, options) !== null;
}

/** Whether `text` is a date-time; see {@link DateTimeOptions}. */
export function isDateTime(
  text: string,
  options: DateTimeOptions = {},
): boolean {
  return parseDateTime(text, options) !== null;
}

// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * Strict ISO 8601 / RFC 3339 checks in front of `Temporal`, imported as
 * "@celld/isotime".
 *
 * `Temporal` does the time: arithmetic, time zones, calendars, formatting.
 * Its parsers are lenient, though: they take bracketed zone and calendar
 * annotations, six-digit years, a space for `T`, `+0200`. This library
 * reads only RFC 3339's profile (four-digit years, calendar dates, upper
 * case `T` and `Z`, `±HH:MM`) with zod 4's `precision`/`offset`/`local`
 * rules, and only then builds the `Temporal` value.
 *
 * ```ts
 * import { parseDateTime, parseDuration } from "@celld/isotime";
 *
 * const at = parseDateTime("2026-09-25T10:15:30.25+02:00", { offset: true });
 * at?.toString(); // "2026-09-25T08:15:30.25Z", a Temporal.Instant
 * parseDateTime("2026-09-25T10:15:30+02:00[Europe/Paris]"); // null
 * parseDuration("PT1H30M")?.total("minutes"); // 90
 * ```
 *
 * Parsers return null for text they do not accept; the `is*` functions
 * are their boolean forms. `@celld/sieve` builds its ISO string formats on
 * them.
 *
 * @module
 */

export {
  type DateTimeOptions,
  isDate,
  isDateTime,
  isTime,
  isYearMonth,
  type LocalDateTimeOptions,
  parseDate,
  parseDateTime,
  parseLocalDateTime,
  parseTime,
  parseYearMonth,
  type PrecisionOptions,
  type TimeOptions,
  type ZonedDateTimeOptions,
} from "./datetime.ts";
export { isDuration, parseDuration } from "./duration.ts";

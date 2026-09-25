<!-- SPDX-FileCopyrightText: © 2026 Austin Seipp -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# @celld/isotime

Strict ISO 8601 / RFC 3339 checks for text arriving at a trust boundary,
in front of `Temporal`.

Use `Temporal` for time itself: instants, time zones, calendars,
arithmetic, differences, formatting. celld supports it natively and the
toolchain's TypeScript has its types. Use this library only where text
comes in, to decide whether that text is acceptable before `Temporal`
sees it.

`Temporal`'s parsers are lenient on purpose. `Temporal.Instant.from` takes
`2026-09-25 10:15+0200`, `+002026-09-25T10:15Z`, and
`2026-09-25T10:15Z[Europe/Paris][u-ca=gregory]`. They also cannot express
rules such as "exactly three fractional digits" or "`Z` only, no offset".
This library reads only RFC 3339's profile, applies zod 4's
`precision`/`offset`/`local` rules, and then returns the `Temporal` value
for text that passes.

```typescript
import { parseDateTime, parseDuration } from "@celld/isotime";

const at = parseDateTime("2026-09-25T10:15:30.25+02:00", { offset: true });
// Temporal.Instant 2026-09-25T08:15:30.25Z
at!.toZonedDateTimeISO("America/New_York").toString();
// "2026-09-25T04:15:30.25-04:00[America/New_York]"

parseDateTime("2026-09-25T10:15:30+02:00"); // null: Z only by default
parseDateTime("2026-09-25T10:15:30Z[UTC]"); // null: no annotations

const every = parseDuration("P1M")!; // Temporal.Duration
Temporal.PlainDate.from("2024-01-31").add(every).toString(); // "2024-02-29"
```

## What it accepts

| Function | Text | Options | Returns |
| --- | --- | --- | --- |
| `parseDate` | `YYYY-MM-DD` | none | `Temporal.PlainDate` |
| `parseYearMonth` | `YYYY-MM` | none | `Temporal.PlainYearMonth` |
| `parseTime` | `HH:MM[:SS[.f]]` | `precision`, `zone: "none" \| "required" \| "any"` (default `"none"`) | `Temporal.PlainTime` |
| `parseDateTime` | `YYYY-MM-DDTHH:MM[:SS[.f]]` + zone | `precision`, `offset`, `local` | `Temporal.Instant`, or with `local: true` also `Temporal.PlainDateTime` |
| `parseLocalDateTime` | the same, with no zone | `precision` | `Temporal.PlainDateTime` |
| `parseDuration` | `PnYnMnDTnHnMnS` or `PnW` | none | `Temporal.Duration` |

Each returns null for text it does not accept, and each has an `is*` form
that returns a boolean (`isDate`, `isYearMonth`, `isTime`, `isDateTime`,
`isDuration`).
`parseDateTime` is overloaded: without `local: true` its result is typed as
an `Instant`; with it, callers tell the two apart with `instanceof`. The
options match zod 4's `z.iso.*`, and `@celld/sieve` builds on them:

- `precision`: `-1` means minutes only, `0` whole seconds, `n` exactly `n`
  fractional digits. Without it, seconds are optional and a fraction may
  have any number of digits (digits past nanoseconds are cut off).
- Date-times accept `Z` by default. `offset: true` also accepts `±HH:MM`,
  and `local: true` also accepts no zone.
- Times take no zone by default, like `z.iso.time`. `zone: "required"` is
  RFC 3339's `full-time`. A `PlainTime` has no zone, so the zone is
  checked and then dropped.

Deliberately rejected: lower-case `t` and `z`, a space instead of `T`,
`±HHMM` and `±HH` offsets, bracketed zone or calendar annotations, leap
seconds (`:60`), `24:00`, years outside 0000-9999 (including `±YYYYYY`),
week and ordinal dates, and `,` as the decimal mark in times. RFC 3339's
`-00:00` ("offset unknown") is the same instant as `Z`.

Durations need at least one component, and `T` needs one after it. Weeks
stand alone. Only the last component may have a fraction, written with `.`
or `,`, and only when it is hours, minutes or seconds: a fractional day,
week, month or year has no fixed length, and `Temporal.Duration` refuses
one. Signs are not accepted, and neither is a duration too large for
`Temporal.Duration`.

## Examples

[`examples/`](examples) has standalone Workers that do their time with
`Temporal` and their input checks with this library, each tested under
`celld dev` (`buck2 test root//src/celld/isotime/examples/...`) and
runnable with `buck2 run root//src/celld/isotime/examples:<name>-dev`.

## Tests

```sh
buck2 test root//src/celld/isotime/...
```

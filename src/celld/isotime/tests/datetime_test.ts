// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

import { assert, assertEquals } from "@celld/assert";
import {
  isDate,
  isDateTime,
  isTime,
  isYearMonth,
  parseDate,
  parseDateTime,
  parseLocalDateTime,
  parseTime,
  parseYearMonth,
} from "@celld/isotime";

Deno.test("dates", () => {
  const date = parseDate("2026-09-25");
  assert(date instanceof Temporal.PlainDate, "a PlainDate");
  assertEquals(date.toString(), "2026-09-25");
  assertEquals(parseDate("0033-01-02")?.year, 33);
  for (const text of ["0000-01-01", "9999-12-31", "2024-02-29", "2000-02-29"]) {
    assert(isDate(text), text);
  }
  for (
    const text of [
      "2023-02-29",
      "1900-02-29",
      "2026-04-31",
      "2026-13-01",
      "2026-00-10",
      "2026-01-00",
      "2026-1-01",
      "26-01-01",
      "+002026-01-01",
      "-000001-01-01",
      "10000-01-01",
      "20260101",
      "2026-W39-5",
      "2026-268",
      "2026-09-25T00:00Z",
      "2026-09-25[u-ca=gregory]",
      " 2026-09-25",
    ]
  ) {
    assert(!isDate(text), text);
    assertEquals(parseDate(text), null, text);
  }
});

Deno.test("year-months", () => {
  const month = parseYearMonth("2026-09");
  assert(month instanceof Temporal.PlainYearMonth, "a PlainYearMonth");
  assertEquals(month.toString(), "2026-09");
  assertEquals(month.daysInMonth, 30);
  for (const text of ["0000-01", "9999-12", "2024-02"]) {
    assert(isYearMonth(text), text);
  }
  for (
    const text of [
      "2026-13",
      "2026-00",
      "2026-9",
      "26-09",
      "202609",
      "+002026-09",
      "2026-09-01",
      "2026-W39",
      "2026-09[u-ca=gregory]",
      " 2026-09",
    ]
  ) {
    assert(!isYearMonth(text), text);
    assertEquals(parseYearMonth(text), null, text);
  }
});

Deno.test("times: zod's defaults", () => {
  for (
    const text of [
      "00:00",
      "23:59",
      "12:30:45",
      "12:30:45.1",
      "12:30:45.123456789",
    ]
  ) {
    assert(isTime(text), text);
  }
  for (
    const text of [
      "24:00",
      "12:60",
      "12:30:60",
      "12:30:45.",
      "12:30:45,5",
      "1:30",
      "12:3",
      "12:30Z",
      "12:30:45+01:00",
      "T12:30",
      "12",
      "1230",
      "12:30[UTC]",
    ]
  ) {
    assert(!isTime(text), text);
  }
  const time = parseTime("12:30");
  assert(time instanceof Temporal.PlainTime, "a PlainTime");
  assertEquals(time.toString(), "12:30:00");
  assertEquals(parseTime("12:30:45.500")?.millisecond, 500);
  const fine = parseTime("12:30:45.1234567891")!;
  assertEquals(
    [fine.millisecond, fine.microsecond, fine.nanosecond],
    [123, 456, 789],
  );
});

Deno.test("times: precision", () => {
  const minutes = { precision: -1 };
  assert(isTime("12:30", minutes), "-1 minutes");
  assert(!isTime("12:30:00", minutes), "-1 no seconds");
  const seconds = { precision: 0 };
  assert(isTime("12:30:00", seconds), "0 seconds");
  assert(!isTime("12:30", seconds), "0 needs seconds");
  assert(!isTime("12:30:00.0", seconds), "0 no fraction");
  const millis = { precision: 3 };
  assert(isTime("12:30:00.000", millis), "3");
  assert(!isTime("12:30:00.00", millis), "3 short");
  assert(!isTime("12:30:00.0000", millis), "3 long");
  assert(!isTime("12:30:00", millis), "3 none");
});

Deno.test("times: zones are checked, not kept", () => {
  assertEquals(
    parseTime("12:30:00Z", { zone: "required" })?.toString(),
    "12:30:00",
  );
  assertEquals(
    parseTime("12:30-05:30", { zone: "any" })?.toString(),
    "12:30:00",
  );
  assert(isTime("12:30", { zone: "any" }), "any takes none");
  assert(!isTime("12:30", { zone: "required" }), "required");
  assert(!isTime("12:30+24:00", { zone: "any" }), "offset hour");
  assert(!isTime("12:30+01:60", { zone: "any" }), "offset minute");
  assert(!isTime("12:30+0100", { zone: "any" }), "RFC 3339 needs the colon");
  assert(!isTime("12:30+01", { zone: "any" }), "and the minutes");
  assert(!isTime("12:30z", { zone: "any" }), "upper-case Z");
});

Deno.test("date-times: zod's defaults and options", () => {
  for (
    const text of [
      "2026-09-25T10:15Z",
      "2026-09-25T10:15:30Z",
      "2026-09-25T10:15:30.123456Z",
      "2024-02-29T00:00:00Z",
      "0000-01-01T00:00:00Z",
      "9999-12-31T23:59:59.999999999Z",
    ]
  ) {
    assert(isDateTime(text), text);
  }
  for (
    const text of [
      "2026-09-25T10:15:30",
      "2026-09-25T10:15:30+02:00",
      "2026-09-25 10:15:30Z",
      "2026-09-25t10:15:30Z",
      "2026-09-25T10:15:30z",
      "2023-02-29T10:15:30Z",
      "2026-09-25T24:00:00Z",
      "2026-09-25T23:59:60Z",
      "2026-09-25T10:15:30Z[UTC]",
      "2026-09-25T10:15:30Z[u-ca=gregory]",
      "+002026-09-25T10:15:30Z",
      "2026-09-25T10:15:30,5Z",
      "2026-09-25",
      "2026-09-25T",
    ]
  ) {
    assert(!isDateTime(text), text);
    assertEquals(parseDateTime(text), null, text);
  }
  assert(isDateTime("2026-09-25T10:15:30+02:00", { offset: true }), "offset");
  assert(
    isDateTime("2026-09-25T10:15:30Z", { offset: true }),
    "offset keeps Z",
  );
  assert(
    !isDateTime("2026-09-25T10:15:30", { offset: true }),
    "offset not local",
  );
  assert(
    !isDateTime("2026-09-25T10:15:30+02:00[Europe/Paris]", { offset: true }),
    "no zone annotation",
  );
  assert(
    !isDateTime("2026-09-25T10:15:30+0200", { offset: true }),
    "no +HHMM",
  );
  assert(isDateTime("2026-09-25T10:15:30", { local: true }), "local");
  assert(isDateTime("2026-09-25T10:15:30Z", { local: true }), "local keeps Z");
  assert(
    !isDateTime("2026-09-25T10:15:30+02:00", { local: true }),
    "local not offset",
  );
  assert(
    isDateTime("2026-09-25T10:15:30+02:00", { local: true, offset: true }),
    "both",
  );
  assert(isDateTime("2026-09-25T10:15:30.123Z", { precision: 3 }), "precision");
  assert(
    !isDateTime("2026-09-25T10:15:30Z", { precision: 3 }),
    "precision none",
  );
  assert(isDateTime("2026-09-25T10:15Z", { precision: -1 }), "minutes");
  assert(
    !isDateTime("2026-09-25T10:15:30Z", { precision: -1 }),
    "minutes only",
  );
});

Deno.test("date-times with a zone are instants", () => {
  const at = parseDateTime("2026-09-25T10:15:30.25+02:00", { offset: true });
  assert(at instanceof Temporal.Instant, "an Instant");
  assertEquals(at.toString(), "2026-09-25T08:15:30.25Z");
  assertEquals(at.epochMilliseconds, Date.UTC(2026, 8, 25, 8, 15, 30, 250));
  assertEquals(
    parseDateTime("2026-09-25T08:15:30.123456789Z")?.epochNanoseconds,
    1790324130123456789n,
  );
  assertEquals(
    parseDateTime("2026-01-01T00:30-01:00", { offset: true })?.toString(),
    "2026-01-01T01:30:00Z",
  );
  assertEquals(
    parseDateTime("0001-01-01T00:00:00Z")?.toString(),
    "0001-01-01T00:00:00Z",
  );
  // RFC 3339's "offset unknown" is the same instant as Z.
  assertEquals(
    parseDateTime("2026-09-25T10:15:30-00:00", { offset: true })?.toString(),
    "2026-09-25T10:15:30Z",
  );
});

Deno.test("local date-times are plain date-times", () => {
  const local = parseDateTime("2026-09-25T10:15", { local: true });
  assert(local instanceof Temporal.PlainDateTime, "a PlainDateTime");
  assertEquals(local.toString(), "2026-09-25T10:15:00");
  assert(
    parseDateTime("2026-09-25T10:15Z", { local: true }) instanceof
      Temporal.Instant,
    "a zone still makes an instant",
  );
  assertEquals(
    parseLocalDateTime("2026-09-25T10:15:30.5")?.toString(),
    "2026-09-25T10:15:30.5",
  );
  assertEquals(parseLocalDateTime("2026-09-25T10:15:30Z"), null);
  assertEquals(parseLocalDateTime("2026-09-25T10:15", { precision: 0 }), null);
  assertEquals(
    parseLocalDateTime("2026-09-25T10:15:30[America/New_York]"),
    null,
  );
});

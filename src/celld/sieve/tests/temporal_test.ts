// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

// Temporal schemas, the string conversions to them, and how both show up
// in definitions and JSON Schema.

import { assert, assertEquals, assertThrows } from "@celld/assert";
import { v } from "@celld/sieve";
import { defOf, transforms } from "@celld/sieve/introspect";
import { toJSONSchema } from "@celld/sieve/json-schema";
import { issues } from "./fixture.ts";

function codes(found: readonly { code: string; format?: string }[]) {
  return found.map((issue) =>
    issue.format === undefined ? [issue.code] : [issue.code, issue.format]
  );
}

Deno.test("Temporal schemas accept their own type only", () => {
  const cases = [
    [v.instant(), Temporal.Instant.from("2026-09-25T10:15:30Z")],
    [
      v.zonedDateTime(),
      Temporal.ZonedDateTime.from("2026-09-25T10:15[Europe/Paris]"),
    ],
    [v.plainDate(), Temporal.PlainDate.from("2026-09-25")],
    [v.plainTime(), Temporal.PlainTime.from("10:15")],
    [v.plainDateTime(), Temporal.PlainDateTime.from("2026-09-25T10:15")],
    [v.duration(), Temporal.Duration.from("PT1H")],
  ] as const;
  for (const [schema, value] of cases) {
    assert(schema.parse(value) === value, `${value}`);
    for (const [, other] of cases) {
      if (other !== value) assert(!schema.is(other), `${value} vs ${other}`);
    }
  }
  assertEquals(issues(v.instant(), "2026-09-25T10:15:30Z"), [{
    code: "invalid_type",
    expected: "Temporal.Instant",
    received: "string",
    path: [],
    message: "expected Temporal.Instant, received string",
  }]);
  assertEquals(
    issues(v.duration(), new Date())[0].message,
    "expected Temporal.Duration, received Date",
  );
  assertEquals(issues(v.plainDate("a day"), 1)[0].message, "a day");
});

Deno.test("strings convert to Temporal values", () => {
  const at = v.iso.datetime({ offset: true }).toInstant().parse(
    "2026-09-25T10:15:30.25+02:00",
  );
  assert(at instanceof Temporal.Instant, "an Instant");
  assertEquals(at.toString(), "2026-09-25T08:15:30.25Z");
  const day = v.iso.date().toPlainDate().parse("2024-02-29");
  assertEquals(day.dayOfWeek, 4);
  assertEquals(
    v.iso.time().toPlainTime().parse("12:30:00.5").toString(),
    "12:30:00.5",
  );
  assertEquals(
    v.iso.datetime({ local: true }).toPlainDateTime()
      .parse("2026-09-25T10:15").toString(),
    "2026-09-25T10:15:00",
  );
  const every = v.iso.duration().toDuration().parse("P1M");
  assertEquals(
    Temporal.PlainDate.from("2024-01-31").add(every).toString(),
    "2024-02-29",
  );
});

Deno.test("the string check runs first, with zod's options and messages", () => {
  const precise = v.iso.datetime({ precision: 3 }).toInstant();
  assert(precise.is("2026-09-25T10:15:30.250Z"), "three digits");
  assertEquals(codes(issues(precise, "2026-09-25T10:15:30Z")), [
    ["invalid_format", "datetime"],
  ]);
  assertEquals(
    codes(issues(v.iso.datetime().toInstant(), "2026-09-25T10:15+02:00")),
    [["invalid_format", "datetime"]],
  );
  assertEquals(
    codes(issues(v.iso.date().toPlainDate(), 20260925)),
    [["invalid_type"]],
  );
  assertEquals(
    issues(v.string().isoDate("a date, please").toPlainDate(), "x")[0].message,
    "a date, please",
  );
});

Deno.test("conversions are strict on their own", () => {
  // No string check before them: isotime's parsers still decide.
  for (
    const [schema, text, format] of [
      [v.string().toInstant(), "2026-09-25T10:15:30z", "datetime"],
      [v.string().toInstant(), "2026-09-25 10:15:30Z", "datetime"],
      [v.string().toInstant(), "2026-09-25T10:15:30Z[UTC]", "datetime"],
      [v.string().toInstant(), "+002026-09-25T10:15:30Z", "datetime"],
      [v.string().toInstant(), "2016-12-31T23:59:60Z", "datetime"],
      [v.string().toInstant(), "2026-09-25T10:15:30", "datetime"],
      [v.string().toPlainDateTime(), "2026-09-25T10:15:30Z", "datetime"],
      [v.string().toPlainDate(), "2023-02-29", "date"],
      [v.string().toPlainDate(), "2026-09-25T00:00Z", "date"],
      [v.string().toPlainTime(), "12:30Z", "time"],
      [v.string().toPlainTime(), "24:00", "time"],
      [v.string().toDuration(), "-P1D", "duration"],
      [v.string().toDuration(), "P1.5D", "duration"],
      [v.string().toDuration(), "pt1h", "duration"],
    ] as const
  ) {
    assertEquals(
      codes(issues(schema, text)),
      [["invalid_format", format]],
      text,
    );
  }
  assertEquals(
    v.string().toInstant().parse("2026-09-25T10:15:30+02:00").toString(),
    "2026-09-25T08:15:30Z",
  );
  assertEquals(
    issues(v.string().toDuration("not a TTL"), "10m")[0].message,
    "not a TTL",
  );
  assertEquals(
    issues(v.string().toDuration(), "10m")[0].message,
    "invalid ISO 8601 duration",
  );
});

Deno.test("conversions compose", () => {
  const Reminder = v.object({
    at: v.iso.datetime({ offset: true }).toInstant(),
    every: v.iso.duration().toDuration().optional(),
    on: v.iso.date().toPlainDate().nullable(),
  });
  const parsed = Reminder.parse({
    at: "2026-09-25T10:15:30Z",
    every: "P1W",
    on: null,
    extra: 1,
  });
  assertEquals(parsed.at.epochMilliseconds, Date.UTC(2026, 8, 25, 10, 15, 30));
  assertEquals(parsed.every?.weeks, 1);
  assertEquals(parsed.on, null);
  const Future = v.iso.datetime().toInstant().refine(
    (at) => Temporal.Instant.compare(at, Temporal.Now.instant()) > 0,
    "must be in the future",
  );
  assertEquals(
    issues(Future, "2000-01-01T00:00:00Z")[0].message,
    "must be in the future",
  );
  const Both = v.intersection(
    v.iso.date().toPlainDate(),
    v.string().toPlainDate(),
  );
  assertEquals(Both.parse("2026-09-25").toString(), "2026-09-25");
});

Deno.test("definitions", () => {
  assertEquals(defOf(v.instant()), {
    kind: "temporal",
    type: "instant",
    coerce: false,
    checks: [],
  });
  const converted = v.iso.duration().toDuration();
  const def = defOf(converted);
  assert(def.kind === "pipe", "a pipe");
  assertEquals(defOf(def.out), {
    kind: "temporal",
    type: "duration",
    coerce: true,
    checks: [],
  });
  assert(transforms(converted), "a conversion changes the value");
  assert(!transforms(v.instant()), "a Temporal schema does not");
});

Deno.test("JSON Schema: strings on input, unrepresentable on output", () => {
  const Body = v.object({
    at: v.iso.datetime({ offset: true }).toInstant(),
    on: v.string().toPlainDate(),
    time: v.string().toPlainTime(),
    local: v.string().toPlainDateTime(),
    every: v.iso.duration().toDuration().optional(),
  });
  assertEquals(toJSONSchema(Body, { io: "input" }).properties, {
    at: { type: "string", format: "date-time" },
    on: { type: "string", format: "date" },
    time: { type: "string", format: "time" },
    local: { type: "string", format: "date-time" },
    every: { type: "string", format: "duration" },
  });
  assertThrows(
    () => toJSONSchema(Body),
    Error,
    "Temporal (instant) cannot be represented in JSON Schema",
  );
  assertEquals(
    toJSONSchema(Body, { unrepresentable: "any" }).properties,
    { at: {}, on: {}, time: {}, local: {}, every: {} },
  );
  assertThrows(
    () => toJSONSchema(v.instant(), { io: "input" }),
    Error,
    "Temporal (instant)",
  );
});

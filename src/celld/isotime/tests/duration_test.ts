// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

import { assert, assertEquals } from "@celld/assert";
import { isDuration, parseDuration } from "@celld/isotime";

Deno.test("durations are Temporal.Durations", () => {
  const duration = parseDuration("P1Y2M3DT4H5M6S");
  assert(duration instanceof Temporal.Duration, "a Duration");
  assertEquals(
    [
      duration.years,
      duration.months,
      duration.days,
      duration.hours,
      duration.minutes,
      duration.seconds,
    ],
    [1, 2, 3, 4, 5, 6],
  );
  assertEquals(parseDuration("P2W")?.weeks, 2);
  assertEquals(parseDuration("PT0S")?.blank, true);
  assertEquals(parseDuration("P1M")?.months, 1);
  assertEquals(parseDuration("PT1M")?.minutes, 1);
  // Temporal spreads a fraction over the smaller units.
  assertEquals(parseDuration("PT1.5H")?.toString(), "PT1H30M");
  assertEquals(parseDuration("P1DT0,25S")?.toString(), "P1DT0.25S");
  assertEquals(parseDuration("PT0.0000000019S")?.toString(), "PT0.000000001S");
});

Deno.test("accepted", () => {
  for (
    const text of [
      "P1D",
      "PT36H",
      "P0D",
      "P1Y",
      "P10000W",
      "PT0.001S",
      "PT0.5M",
      "PT1,5H",
    ]
  ) {
    assert(isDuration(text), text);
  }
});

Deno.test("rejected", () => {
  for (
    const text of [
      "",
      "P",
      "PT",
      "P1DT",
      "1D",
      "P1H",
      "PT1D",
      "P1W1D",
      "P1D1Y",
      "PT1S1M",
      "P1.5DT1H",
      "PT1.5H30M",
      "P-1D",
      "-P1D",
      "+P1D",
      "P1.D",
      "P.5D",
      "p1d",
      "P1d",
      "P 1D",
      "pt1h",
      // A fractional day, week, month or year has no fixed length.
      "P1.5D",
      "P0.5W",
      "P1.5M",
      "P0,5Y",
      // Too large for Temporal.Duration.
      "PT99999999999999999999S",
    ]
  ) {
    assert(!isDuration(text), text);
    assertEquals(parseDuration(text), null, text);
  }
});

Deno.test("Temporal does the arithmetic", () => {
  const month = parseDuration("P1M")!;
  assertEquals(
    month.total({ unit: "days", relativeTo: "2024-01-31" }),
    29,
  );
  assertEquals(
    Temporal.PlainDate.from("2024-01-31").add(month).toString(),
    "2024-02-29",
  );
  assertEquals(parseDuration("PT1H30M")!.total("milliseconds"), 5_400_000);
});

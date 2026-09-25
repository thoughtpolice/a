// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

import { assert, assertEquals } from "@celld/core/assert";
import { durationMs } from "@celld/box/container";

// Rewritten (DB-SBX-013): this test asserted that a number meant seconds
// (and a bare "45" too), while every per-call field of the sandbox takes
// milliseconds as `*Ms`. The mixed units were the defect: a duration is now
// a string with its unit, and numbers are refused.
Deno.test("numbers and unitless strings are refused: the unit must be written", () => {
  for (const bad of [90, 0.5, 0, "45", "0"]) {
    let error: unknown = null;
    try {
      durationMs(bad as string);
    } catch (caught) {
      error = caught;
    }
    assert(error instanceof RangeError, String(bad));
  }
});

Deno.test("short forms add up", () => {
  assertEquals(durationMs("500ms"), 500);
  assertEquals(durationMs("30s"), 30_000);
  assertEquals(durationMs("10m"), 600_000);
  assertEquals(durationMs("2h"), 7_200_000);
  assertEquals(durationMs("1d"), 86_400_000);
  assertEquals(durationMs("1h30m"), 5_400_000);
  assertEquals(durationMs("1m30s250ms"), 90_250);
  assertEquals(durationMs("1.5s"), 1_500);
});

Deno.test("duration option records reject unknown keys and coerced bounds", () => {
  for (
    const options of [{ typo: 1 }, { max: "1000" }, { min: false }, {
      name: {},
    }, { max: Infinity }]
  ) {
    let failed = false;
    try {
      durationMs("1s", options as never);
    } catch {
      failed = true;
    }
    assert(failed, "invalid duration options");
  }
});

Deno.test("ISO 8601 durations go through Temporal.Duration", () => {
  assertEquals(durationMs("PT10M"), 600_000);
  assertEquals(durationMs("PT1H30S"), 3_630_000);
});

Deno.test("anything else is refused", () => {
  for (
    const bad of [
      -1,
      Number.NaN,
      Infinity,
      "",
      "   ",
      "\t",
      "10x",
      "m",
      "P1M",
      "PT",
      "1s 2s",
    ]
  ) {
    let threw = false;
    try {
      durationMs(bad as string);
    } catch (error) {
      threw = error instanceof RangeError;
    }
    assert(threw, String(bad));
  }
});

Deno.test("results are checked after conversion", () => {
  // Past the safe range once multiplied: refused, never Infinity.
  for (const bad of ["1e400s", `${"9".repeat(400)}d`, "P99999999999D"]) {
    let threw = false;
    try {
      durationMs(bad);
    } catch (error) {
      threw = error instanceof RangeError;
    }
    assert(threw, bad);
  }
  // A maximum and a minimum apply to the converted value.
  assertEquals(durationMs("2m", { name: "x", max: 120_000 }), 120_000);
  for (const [bad, max, min] of [["2m1ms", 120_000, 0], ["5ms", 60_000, 10]]) {
    let threw = false;
    try {
      durationMs(bad as string, {
        name: "x",
        max: max as number,
        min: min as number,
      });
    } catch (error) {
      threw = error instanceof RangeError &&
        (error as Error).message.includes("x");
    }
    assert(threw, String(bad));
  }
  // The default maximum is a timer's range (about 24.8 days).
  assertEquals(durationMs("24d"), 24 * 86_400_000);
  let threw = false;
  try {
    durationMs("25d");
  } catch {
    threw = true;
  }
  assert(threw, "25d");
});

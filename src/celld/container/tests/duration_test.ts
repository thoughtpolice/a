// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

import { assert, assertEquals } from "@celld/assert";
import { durationMs } from "@celld/container";

Deno.test("numbers are seconds, as in Cloudflare", () => {
  assertEquals(durationMs(90), 90_000);
  assertEquals(durationMs(0.5), 500);
  assertEquals(durationMs("45"), 45_000);
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

Deno.test("ISO 8601 durations go through Temporal.Duration", () => {
  assertEquals(durationMs("PT10M"), 600_000);
  assertEquals(durationMs("PT1H30S"), 3_630_000);
});

Deno.test("anything else is refused", () => {
  for (const bad of [-1, Number.NaN, Infinity, "", "10x", "m", "P1M", "PT"]) {
    let threw = false;
    try {
      durationMs(bad);
    } catch (error) {
      threw = error instanceof RangeError;
    }
    assert(threw, String(bad));
  }
});

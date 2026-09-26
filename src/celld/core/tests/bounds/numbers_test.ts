// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

import { assertEquals, assertThrows } from "./assert.ts";
import {
  BoundsError,
  bytes,
  count,
  depth,
  finite,
  MAX_TIMER_MS,
  millis,
  nonNegativeMs,
  type NumberOptions,
  safeInt,
} from "@celld/core/bounds";

// Every helper must refuse these, whatever its range.
const NOT_NUMBERS: unknown[] = [
  "1",
  null,
  undefined,
  true,
  1n,
  {},
  [1],
  new Number(1),
];
const NOT_FINITE = [
  Number.NaN,
  Number.POSITIVE_INFINITY,
  Number.NEGATIVE_INFINITY,
];

function refuses(check: (value: unknown) => unknown, value: unknown) {
  const error = assertThrows(() => check(value), BoundsError);
  assertEquals(
    error instanceof RangeError,
    true,
    "a BoundsError is a RangeError",
  );
  return error;
}

Deno.test("finite refuses non-numbers, NaN and infinities", () => {
  for (const value of NOT_NUMBERS) {
    assertEquals(refuses((v) => finite(v, { name: "x" }), value).code, "type");
  }
  for (const value of NOT_FINITE) {
    assertEquals(refuses((v) => finite(v, { name: "x" }), value).code, "range");
  }
});

Deno.test("finite checks its range and names the value", () => {
  assertEquals(finite(0.5, { name: "ratio", min: 0, max: 1 }), 0.5);
  assertEquals(finite(-3, { name: "x" }), -3);
  const low = refuses(
    (v) => finite(v, { name: "ratio", min: 0, max: 1 }),
    -0.1,
  );
  assertEquals(low.code, "range");
  assertEquals(low.message.includes("ratio"), true, low.message);
  refuses((v) => finite(v, { name: "ratio", min: 0, max: 1 }), 1.01);
});

Deno.test("safeInt refuses fractions and unsafe integers", () => {
  assertEquals(safeInt(7, { name: "n" }), 7);
  assertEquals(safeInt(-7, { name: "n" }), -7);
  assertEquals(
    safeInt(Number.MAX_SAFE_INTEGER, { name: "n" }),
    Number.MAX_SAFE_INTEGER,
  );
  for (const value of NOT_NUMBERS) {
    assertEquals(refuses((v) => safeInt(v, { name: "n" }), value).code, "type");
  }
  for (
    const value of [
      ...NOT_FINITE,
      1.5,
      Number.MAX_SAFE_INTEGER + 1,
      -(2 ** 60),
    ]
  ) {
    assertEquals(
      refuses((v) => safeInt(v, { name: "n" }), value).code,
      "range",
    );
  }
  refuses((v) => safeInt(v, { name: "n", min: 1 }), 0);
  refuses((v) => safeInt(v, { name: "n", max: 10 }), 11);
});

Deno.test("nonNegativeMs refuses negatives and timer-overflowing values", () => {
  assertEquals(nonNegativeMs(0, { name: "ttlMs" }), 0);
  assertEquals(nonNegativeMs(60_000, { name: "ttlMs" }), 60_000);
  assertEquals(nonNegativeMs(MAX_TIMER_MS, { name: "ttlMs" }), MAX_TIMER_MS);
  for (const value of NOT_NUMBERS) {
    refuses((v) => nonNegativeMs(v, { name: "ttlMs" }), value);
  }
  for (const value of [...NOT_FINITE, -1, -0.5, MAX_TIMER_MS + 1]) {
    assertEquals(
      refuses((v) => nonNegativeMs(v, { name: "ttlMs" }), value).code,
      "range",
    );
  }
  // A caller may lower the cap but never raise it past a timer's range.
  refuses((v) => nonNegativeMs(v, { name: "ttlMs", max: 1000 }), 1001);
  assertThrows(
    () => nonNegativeMs(1, { name: "ttlMs", max: MAX_TIMER_MS * 2 }),
    RangeError,
  );
});

Deno.test("the composing idiom returns the checked value", () => {
  const options: { ttlMs?: number } = {};
  const ttl = nonNegativeMs(options.ttlMs ?? 60_000, {
    name: "ttlMs",
    max: 3_600_000,
  });
  assertEquals(ttl, 60_000);
});

Deno.test("number ranges cannot be disabled by malformed option values", () => {
  for (const check of [finite, safeInt, nonNegativeMs]) {
    for (const bound of [NaN, Infinity, -Infinity, "100", null, true, {}]) {
      for (const field of ["min", "max"]) {
        assertThrows(() =>
          check(1, { name: "limit", [field]: bound } as NumberOptions)
        );
      }
    }
    for (
      const options of [
        { name: "limit", min: 2, max: 1 },
        { name: "limit", maximum: 0 },
        { name: 3 },
        { name: "" },
        { name: "x".repeat(257) },
        Object.create({ name: "limit", max: 0 }),
        null,
      ]
    ) assertThrows(() => check(1, options as NumberOptions));
    let invoked = false;
    assertThrows(() =>
      check(1, {
        name: "limit",
        get max() {
          invoked = true;
          return 0;
        },
      })
    );
    assertEquals(invoked, false);
    assertEquals(
      check(1, { name: "limit", min: undefined, max: undefined }),
      1,
    );
  }
  for (const options of [{ min: -1 }, { max: -1 }, { min: MAX_TIMER_MS + 1 }]) {
    assertThrows(
      () => nonNegativeMs(0, { name: "duration", ...options }),
      RangeError,
    );
  }
});

Deno.test("limit constructors validate and brand", () => {
  const b: number = bytes(1024);
  const c: number = count(0);
  const d: number = depth(32);
  const m: number = millis(250);
  assertEquals([b, c, d, m], [1024, 0, 32, 250]);
  for (
    const make of [bytes, count, depth, millis] as ((n: unknown) => number)[]
  ) {
    for (const value of [...NOT_NUMBERS, ...NOT_FINITE, -1]) {
      refuses(make, value);
    }
  }
  for (const make of [bytes, count, depth] as ((n: unknown) => number)[]) {
    refuses(make, 1.5);
    refuses(make, Number.MAX_SAFE_INTEGER + 2);
  }
});

// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

import { assertEquals, assertThrows } from "./assert.ts";
import {
  boundedList,
  boundedString,
  BoundsError,
  type StringBound,
  utf8Length,
} from "@celld/core/bounds";

Deno.test("collection options reject misspellings and accessors without invocation", () => {
  for (
    const check of [
      (options: unknown) =>
        boundedList([], options as { max: number; name: string }),
      (options: unknown) => boundedString("", options as StringBound),
    ]
  ) {
    for (
      const options of [null, [], { name: "x", max: 1, maxLength: 1 }, {
        name: "x",
        maximum: 1,
      }]
    ) {
      assertThrows(() => check(options));
    }
    let invoked = false;
    assertThrows(() =>
      check({
        get name() {
          invoked = true;
          return "x";
        },
      })
    );
    assertEquals(invoked, false);
  }
  assertThrows(() => utf8Length(123 as unknown as string), BoundsError);
});

Deno.test("boundedList passes lists within the cap", () => {
  const items = [1, 2, 3];
  assertEquals(boundedList(items, { max: 3, name: "keys" }), items);
  assertEquals(boundedList([], { max: 0, name: "keys" }), []);
  const longestName = "x".repeat(256);
  assertEquals(boundedList(items, { max: 3, name: longestName }), items);
  assertEquals(boundedString("x", { maxLength: 1, name: longestName }), "x");
  assertEquals(boundedString("é", { maxBytes: 2, name: longestName }), "é");
});

Deno.test("boundedList refuses long lists and non-lists", () => {
  const long = assertThrows(
    () => boundedList([1, 2, 3, 4], { max: 3, name: "keys" }),
    BoundsError,
  );
  assertEquals(long.code, "too_many");
  assertEquals(long.message.includes("keys"), true, long.message);
  for (const value of [null, undefined, "abc", { length: 1 }, new Set([1])]) {
    const error = assertThrows(
      () =>
        boundedList(value as unknown as unknown[], { max: 3, name: "keys" }),
      BoundsError,
    );
    assertEquals(error.code, "type");
  }
});

Deno.test("boundedList validates its cap", () => {
  for (const max of [Number.NaN, -1, 1.5, Number.POSITIVE_INFINITY]) {
    assertThrows(() => boundedList([], { max, name: "keys" }), RangeError);
  }
});

Deno.test("boundedString by length counts UTF-16 code units", () => {
  assertEquals(boundedString("abc", { maxLength: 3, name: "state" }), "abc");
  assertEquals(
    assertThrows(
      () => boundedString("abcd", { maxLength: 3, name: "state" }),
      BoundsError,
    ).code,
    "too_large",
  );
});

Deno.test("boundedString by bytes counts UTF-8", () => {
  assertEquals(boundedString("éé", { maxBytes: 4, name: "state" }), "éé");
  assertEquals(
    assertThrows(
      () => boundedString("ééé", { maxBytes: 5, name: "state" }),
      BoundsError,
    ).code,
    "too_large",
  );
  // A lone surrogate encodes as U+FFFD, three bytes.
  assertThrows(
    () => boundedString("\ud800", { maxBytes: 2, name: "state" }),
    BoundsError,
  );
});

Deno.test("boundedString refuses non-strings and bad caps", () => {
  for (const value of [1, null, undefined, ["a"], new String("a")]) {
    assertEquals(
      assertThrows(
        () =>
          boundedString(value as unknown as string, {
            maxLength: 3,
            name: "s",
          }),
        BoundsError,
      ).code,
      "type",
    );
  }
  for (const max of [Number.NaN, -1, 1.5]) {
    assertThrows(
      () => boundedString("a", { maxLength: max, name: "s" }),
      RangeError,
    );
    assertThrows(
      () => boundedString("a", { maxBytes: max, name: "s" }),
      RangeError,
    );
  }
  // Exactly one of the two caps.
  assertThrows(
    () =>
      boundedString(
        "a",
        { name: "s" } as unknown as { maxLength: number; name: string },
      ),
    RangeError,
  );
  assertThrows(
    () =>
      boundedString(
        "a",
        { maxLength: 1, maxBytes: 1, name: "s" } as unknown as {
          maxLength: number;
          name: string;
        },
      ),
    RangeError,
  );
});

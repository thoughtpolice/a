// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

import { assertEquals, assertThrows } from "@celld/assert";
import { v } from "@celld/sieve";
import { issues } from "./fixture.ts";

function typeIssue(expected: string, received: string, message?: string) {
  return {
    code: "invalid_type",
    expected,
    received,
    path: [],
    message: message ?? `expected ${expected}, received ${received}`,
  };
}

Deno.test("primitives accept their type and name what they got", () => {
  assertEquals(v.string().parse("x"), "x");
  assertEquals(v.number().parse(1.5), 1.5);
  assertEquals(v.bigint().parse(3n), 3n);
  assertEquals(v.boolean().parse(false), false);
  assertEquals(v.null().parse(null), null);
  assertEquals(v.undefined().parse(undefined), undefined);
  assertEquals(v.unknown().parse({ a: 1 }), { a: 1 });

  assertEquals(issues(v.string(), 1), [typeIssue("string", "number")]);
  assertEquals(issues(v.number(), "1"), [typeIssue("number", "string")]);
  assertEquals(issues(v.number(), NaN), [typeIssue("number", "NaN")]);
  assertEquals(issues(v.number(), Infinity), [typeIssue("number", "Infinity")]);
  assertEquals(issues(v.bigint(), 1), [typeIssue("bigint", "number")]);
  assertEquals(issues(v.boolean(), "true"), [typeIssue("boolean", "string")]);
  assertEquals(issues(v.null(), undefined), [typeIssue("null", "undefined")]);
  assertEquals(issues(v.undefined(), null), [typeIssue("undefined", "null")]);
  assertEquals(issues(v.never(), 1), [typeIssue("never", "number")]);
  assertEquals(issues(v.string(), []), [typeIssue("string", "array")]);
  assertEquals(issues(v.string(), new Map()), [typeIssue("string", "Map")]);
});

Deno.test("constructors take a custom type message", () => {
  assertEquals(
    issues(v.string("need text"), 1),
    [typeIssue("string", "number", "need text")],
  );
  assertEquals(
    issues(v.number({ message: "need a number" }), "x"),
    [typeIssue("number", "string", "need a number")],
  );
});

Deno.test("int is a safe integer", () => {
  assertEquals(v.int().parse(7), 7);
  assertEquals(issues(v.int(), 1.5), [typeIssue("int", "number")]);
  assertEquals(issues(v.int(), 2 ** 53), [typeIssue("int", "number")]);
  assertEquals(issues(v.int(), "1"), [typeIssue("number", "string")]);
});

Deno.test("number bounds", () => {
  const small = (minimum: number, inclusive: boolean, message: string) => ({
    code: "too_small",
    origin: "number",
    minimum,
    inclusive,
    path: [],
    message,
  });
  const big = (maximum: number, inclusive: boolean, message: string) => ({
    code: "too_big",
    origin: "number",
    maximum,
    inclusive,
    path: [],
    message,
  });
  assertEquals(v.number().min(1).parse(1), 1);
  assertEquals(issues(v.number().min(1), 0), [
    small(1, true, "must be at least 1"),
  ]);
  assertEquals(issues(v.number().gte(1), 0), [
    small(1, true, "must be at least 1"),
  ]);
  assertEquals(issues(v.number().gt(1), 1), [
    small(1, false, "must be greater than 1"),
  ]);
  assertEquals(issues(v.number().max(1), 2), [
    big(1, true, "must be at most 1"),
  ]);
  assertEquals(issues(v.number().lte(1), 2), [
    big(1, true, "must be at most 1"),
  ]);
  assertEquals(issues(v.number().lt(1), 1), [
    big(1, false, "must be less than 1"),
  ]);
  assertEquals(issues(v.number().positive(), 0), [
    small(0, false, "must be greater than 0"),
  ]);
  assertEquals(issues(v.number().nonnegative(), -1), [
    small(0, true, "must be at least 0"),
  ]);
  assertEquals(issues(v.number().negative(), 0), [
    big(0, false, "must be less than 0"),
  ]);
  assertEquals(issues(v.number().nonpositive(), 1), [
    big(0, true, "must be at most 0"),
  ]);
  assertEquals(v.number().positive().parse(0.1), 0.1);
});

Deno.test("checks collect every failure and keep custom messages", () => {
  const schema = v.number().max(5, "too many").multipleOf(2, {
    message: "even",
  });
  assertEquals(issues(schema, 7).map((issue) => issue.message), [
    "too many",
    "even",
  ]);
});

Deno.test("multipleOf is exact for decimal steps", () => {
  const cents = v.number().multipleOf(0.01);
  assertEquals(cents.parse(0.3), 0.3);
  assertEquals(cents.parse(19.99), 19.99);
  assertEquals(issues(cents, 0.001), [{
    code: "not_multiple_of",
    divisor: 0.01,
    path: [],
    message: "must be a multiple of 0.01",
  }]);
  assertEquals(v.number().multipleOf(5).parse(-15), -15);
  assertEquals(issues(v.number().multipleOf(5), 7)[0].code, "not_multiple_of");
});

Deno.test("bigint bounds", () => {
  assertEquals(v.bigint().min(2n).parse(2n), 2n);
  assertEquals(issues(v.bigint().positive(), 0n), [{
    code: "too_small",
    origin: "bigint",
    minimum: 0n,
    inclusive: false,
    path: [],
    message: "must be greater than 0",
  }]);
  assertEquals(issues(v.bigint().lt(10n), 10n)[0].code, "too_big");
});

Deno.test("literal and enum", () => {
  assertEquals(v.literal("a").parse("a"), "a");
  assertEquals(v.literal(["a", 1, null]).parse(null), null);
  assertEquals(v.literal("a").value, "a");
  assertEquals(v.literal([1, 2]).values, [1, 2]);
  assertThrows(() => v.literal([1, 2]).value, Error, "several");
  assertEquals(issues(v.literal("a"), "b"), [{
    code: "invalid_value",
    values: ["a"],
    path: [],
    message: 'expected "a"',
  }]);
  assertEquals(
    issues(v.literal([1n, true]), 1)[0].message,
    "expected one of 1n | true",
  );

  const Color = v.enum(["red", "green", "blue"]);
  assertEquals(Color.parse("red"), "red");
  assertEquals(Color.options, ["red", "green", "blue"]);
  assertEquals(Color.enum, { red: "red", green: "green", blue: "blue" });
  assertEquals(Color.exclude(["red"]).options, ["green", "blue"]);
  assertEquals(Color.extract(["blue", "red"]).options, ["red", "blue"]);
  assertEquals(issues(Color, "pink"), [{
    code: "invalid_value",
    values: ["red", "green", "blue"],
    path: [],
    message: 'expected one of "red" | "green" | "blue"',
  }]);
  assertEquals(issues(Color.exclude(["red"]), "red")[0].code, "invalid_value");
});

Deno.test("date, instanceof and bytes", () => {
  const now = new Date(0);
  assertEquals(v.date().parse(now), now);
  assertEquals(issues(v.date(), new Date("nope")), [
    typeIssue("date", "Invalid Date"),
  ]);
  assertEquals(issues(v.date(), "2026-01-01"), [typeIssue("date", "string")]);

  class Point {
    constructor(readonly x: number) {}
  }
  const point = new Point(1);
  assertEquals(v.instanceof(Point).parse(point), point);
  assertEquals(issues(v.instanceof(Point), { x: 1 }), [
    typeIssue("Point", "object"),
  ]);

  const key = v.bytes().length(4);
  assertEquals(key.parse(new Uint8Array(4)), new Uint8Array(4));
  assertEquals(issues(v.bytes(), [1, 2]), [typeIssue("Uint8Array", "array")]);
  assertEquals(issues(key, new Uint8Array(5)), [{
    code: "too_big",
    origin: "bytes",
    maximum: 4,
    inclusive: true,
    exact: true,
    path: [],
    message: "must have exactly 4 bytes",
  }]);
  assertEquals(
    issues(v.bytes().min(2), new Uint8Array(1))[0].message,
    "must have at least 2 bytes",
  );
  assertEquals(
    issues(v.bytes().max(0), new Uint8Array(1))[0].message,
    "must have at most 0 bytes",
  );
});

Deno.test("coerce converts first", () => {
  assertEquals(v.coerce.string().parse(12), "12");
  assertEquals(v.coerce.string().parse(null), "null");
  assertEquals(v.coerce.number().parse("1.5"), 1.5);
  assertEquals(v.coerce.number().int().parse("3"), 3);
  assertEquals(issues(v.coerce.number(), "abc"), [typeIssue("number", "NaN")]);
  assertEquals(v.coerce.boolean().parse("false"), true);
  assertEquals(v.coerce.boolean().parse(0), false);
  assertEquals(v.coerce.bigint().parse("42"), 42n);
  assertEquals(issues(v.coerce.bigint(), "4.2"), [
    typeIssue("bigint", "string"),
  ]);
  assertEquals(v.coerce.date().parse(0).getTime(), 0);
  assertEquals(
    v.coerce.date().parse("2026-09-25T00:00:00Z").getTime(),
    Date.UTC(2026, 8, 25),
  );
  assertEquals(issues(v.coerce.date(), "nope"), [
    typeIssue("date", "Invalid Date"),
  ]);
});

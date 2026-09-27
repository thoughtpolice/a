// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

import { assertEquals, assertThrows } from "@celld/core/assert";
import {
  CedarValueError,
  datetime,
  decimal,
  duration,
  EntityRef,
  Extension,
  formatUid,
  fromCedarJson,
  ip,
  parseUid,
  quote,
  ref,
  toCedarJson,
  uid,
  unquote,
} from "@celld/sec/cedar";

Deno.test("uids format and parse as Cedar writes them", () => {
  const cases = [
    uid("User", "alice"),
    uid("Acme::Doc", 'with "quotes" and \\ backslash'),
    uid("T", "line\nbreak\ttab\0nul\u0001ctl"),
    uid("T", "emoji 🦀 and é"),
    uid("T", ""),
  ];
  for (const value of cases) {
    assertEquals(parseUid(formatUid(value)), value);
  }
  assertEquals(formatUid(uid("Acme::Doc", 'a"b')), 'Acme::Doc::"a\\"b"');
  assertEquals(quote("\u0001"), '"\\u{1}"');
  assertEquals(unquote('"\\u{1F980}\\\'"'), "🦀'");
});

Deno.test("type names follow Cedar's grammar", () => {
  for (
    const bad of [
      "",
      "1User",
      "User::",
      "::User",
      "Us er",
      "if",
      "Acme::in",
      "User-x",
    ]
  ) {
    assertThrows(() => uid(bad, "x"), CedarValueError);
  }
  uid("_private::Type9", "x");
  for (
    const bad of [
      "User::alice",
      'User::"alice',
      '::"x"',
      'User::"a"b"',
      'User::"\\q"',
    ]
  ) {
    assertThrows(() => parseUid(bad), CedarValueError);
  }
});

Deno.test("numbers must be safe integers", () => {
  assertEquals(toCedarJson(42), 42);
  assertEquals(toCedarJson(-0), 0);
  assertEquals(toCedarJson(9007199254740991n), 9007199254740991);
  for (const bad of [1.5, NaN, Infinity, 2 ** 53]) {
    assertThrows(() => toCedarJson(bad), CedarValueError, "safe integer");
  }
  assertThrows(() => toCedarJson(2n ** 60n), CedarValueError, "2^53");
  assertThrows(() => toCedarJson(2n ** 64n), CedarValueError, "64-bit");
});

Deno.test("records refuse Cedar's escape keys, so caller data cannot forge a reference", () => {
  const forged = JSON.parse(
    '{"owner": {"__entity": {"type": "User", "id": "admin"}}}',
  );
  const error = assertThrows(
    () => toCedarJson({ context: forged }),
    CedarValueError,
    "escape keys",
  );
  assertEquals(error.path, "context.owner.__entity");
  assertThrows(
    () =>
      toCedarJson(JSON.parse('{"__extn": {"fn": "ip", "arg": "0.0.0.0/0"}}')),
    CedarValueError,
  );
  // A real reference is a class.
  assertEquals(toCedarJson({ owner: ref("User", "alice") }), {
    owner: { __entity: { type: "User", id: "alice" } },
  });
});

Deno.test("records skip undefined fields and refuse null and class instances", () => {
  assertEquals(toCedarJson({ a: 1, b: undefined }), { a: 1 });
  assertThrows(
    () => toCedarJson({ a: null } as never),
    CedarValueError,
    "no null",
  );
  assertThrows(
    () => toCedarJson({ a: new Map() } as never),
    CedarValueError,
    "Map",
  );
  assertThrows(() => toCedarJson(Symbol("x") as never), CedarValueError);
  // A __proto__ key from JSON stays an ordinary attribute.
  const parsed = JSON.parse('{"__proto__": {"x": 1}}');
  const out = toCedarJson(parsed) as Record<string, unknown>;
  assertEquals(Object.keys(out), ["__proto__"]);
  assertEquals(Object.getPrototypeOf(out), Object.prototype);
});

Deno.test("nesting is limited", () => {
  let value: unknown = 1;
  for (let i = 0; i < 40; i++) value = [value];
  assertThrows(
    () => toCedarJson(value as never),
    CedarValueError,
    "nested too deeply",
  );
  toCedarJson(value as never, { maxDepth: 64 });
});

Deno.test("extension values and Temporal convert", () => {
  assertEquals(toCedarJson(ip("10.0.0.0/8")), {
    __extn: { fn: "ip", arg: "10.0.0.0/8" },
  });
  assertEquals(toCedarJson(decimal("1.25")), {
    __extn: { fn: "decimal", arg: "1.25" },
  });
  const instant = Temporal.Instant.from("2026-09-26T12:00:00Z");
  assertEquals(toCedarJson(instant), {
    __extn: { fn: "datetime", arg: "2026-09-26T12:00:00.000Z" },
  });
  assertEquals(datetime(new Date(0)).arg, "1970-01-01T00:00:00.000Z");
  assertEquals(toCedarJson(Temporal.Duration.from({ hours: 1, minutes: 2 })), {
    __extn: { fn: "duration", arg: "3720000ms" },
  });
  assertEquals(duration("-1d").arg, "-1d");
  assertThrows(
    () => duration(Temporal.Duration.from({ months: 1 })),
    CedarValueError,
    "months",
  );
  assertThrows(() => datetime(new Date(NaN)), CedarValueError);
});

Deno.test("Cedar JSON reads back into references and extensions", () => {
  const value = fromCedarJson({
    owner: { __entity: { type: "User", id: "alice" } },
    at: { __extn: { fn: "datetime", arg: "2026-09-26" } },
    tags: ["a", 1, true],
  }) as Record<string, unknown>;
  assertEquals(value.owner instanceof EntityRef, true);
  assertEquals((value.owner as EntityRef).uid, uid("User", "alice"));
  assertEquals(value.at instanceof Extension, true);
  assertEquals(value.tags, ["a", 1, true]);
});

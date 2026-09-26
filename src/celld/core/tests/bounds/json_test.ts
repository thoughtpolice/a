// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

import { assert, assertEquals, assertThrows } from "./assert.ts";
import {
  BoundsError,
  type JsonLimits,
  parseJsonBounded,
} from "@celld/core/bounds";

const LIMITS: JsonLimits = { maxDepth: 4, maxKeys: 3, maxItems: 5 };

Deno.test("JSON options reject unknown keys, nonboolean flags and explicit null", () => {
  for (
    const extra of [
      { maxByte: 1 },
      { allowPrototypeKeys: "true" },
      { allowPrototypeKeys: null },
      { duplicateKeys: null },
      { maxBytes: null },
    ]
  ) {
    assertThrows(() =>
      parseJsonBounded("{}", { ...LIMITS, ...extra } as JsonLimits)
    );
  }
  let invoked = false;
  assertThrows(() =>
    parseJsonBounded("{}", {
      ...LIMITS,
      get allowPrototypeKeys() {
        invoked = true;
        return true;
      },
    })
  );
  assertEquals(invoked, false);
});

function fails(text: string, code: string, limits: JsonLimits = LIMITS) {
  const error = assertThrows(() => parseJsonBounded(text, limits), BoundsError);
  assertEquals(error.code, code, `${text}: ${error.message}`);
  return error;
}

Deno.test("agrees with JSON.parse on valid documents", () => {
  const wide: JsonLimits = { maxDepth: 16, maxKeys: 100, maxItems: 100 };
  for (
    const text of [
      "0",
      "-0",
      "1.5e3",
      "-12.25E-2",
      "1e400",
      '"a\\u00e9\\n\\"\\\\\\/\\b\\f\\r\\t"',
      '"\\ud83d\\ude00"',
      '"\\ud800"',
      "true",
      "false",
      "null",
      "[]",
      "{}",
      ' { "a" : [ 1 , { "b" : null } , "c" ] , "d" : { } } ',
      '["x", 1, true, [false, [null]]]',
      "\t\r\n [ ] \n",
    ]
  ) {
    assertEquals(parseJsonBounded(text, wide), JSON.parse(text), text);
  }
});

Deno.test("rejects what JSON.parse rejects", () => {
  for (
    const text of [
      "",
      " ",
      "01",
      "1.",
      ".5",
      "+1",
      "1e",
      "-",
      "NaN",
      "Infinity",
      "tru",
      "nul",
      "[1,]",
      "[,1]",
      '{"a":1,}',
      '{"a"}',
      "{a:1}",
      "'a'",
      '"\\x41"',
      '"\\u12"',
      '"a\u0001b"',
      '"unterminated',
      "[1] 2",
      "[",
      "{",
      '{"a":',
      " []",
    ]
  ) {
    let native = true;
    try {
      JSON.parse(text);
    } catch {
      native = false;
    }
    assertEquals(native, false, `JSON.parse accepts ${JSON.stringify(text)}`);
    fails(text, "syntax");
  }
});

Deno.test("depth limit counts nested containers", () => {
  assertEquals(parseJsonBounded("[[[[1]]]]", LIMITS), [[[[1]]]]);
  fails("[[[[[1]]]]]", "too_deep");
  fails('{"a":{"b":{"c":{"d":{}}}}}', "too_deep");
  // A deep document fails at the limit, not with a stack overflow.
  const deep = "[".repeat(1_000_000) + "]".repeat(1_000_000);
  fails(deep, "too_deep");
});

Deno.test("keys per object and items per array", () => {
  assertEquals(parseJsonBounded('{"a":1,"b":2,"c":3}', LIMITS), {
    a: 1,
    b: 2,
    c: 3,
  });
  fails('{"a":1,"b":2,"c":3,"d":4}', "too_many");
  assertEquals(parseJsonBounded("[1,2,3,4,5]", LIMITS), [1, 2, 3, 4, 5]);
  fails("[1,2,3,4,5,6]", "too_many");
  // The limits are per container, not totals.
  assertEquals(
    parseJsonBounded("[[1,2,3,4,5],[1,2,3,4,5]]", LIMITS),
    [[1, 2, 3, 4, 5], [1, 2, 3, 4, 5]],
  );
});

Deno.test("maxBytes counts UTF-8 bytes", () => {
  const text = '"ééé"'; // 8 bytes, 5 code units
  assertEquals(parseJsonBounded(text, { ...LIMITS, maxBytes: 8 }), "ééé");
  fails(text, "too_large", { ...LIMITS, maxBytes: 7 });
  fails("[1, 2]", "too_large", { ...LIMITS, maxBytes: 5 });
});

Deno.test("duplicate keys are rejected unless last-wins is asked for", () => {
  fails('{"a":1,"a":2}', "duplicate_key");
  assertEquals(
    parseJsonBounded('{"a":1,"a":2}', { ...LIMITS, duplicateKeys: "last" }),
    { a: 2 },
  );
});

Deno.test("prototype keys are rejected by default", () => {
  for (const key of ["__proto__", "constructor", "prototype"]) {
    fails(`{"${key}":{"polluted":true}}`, "forbidden_key");
    fails(`[{"ok":{"${key}":1}}]`, "forbidden_key");
  }
  // Escapes do not get around the check.
  fails('{"\\u005f_proto__":{}}', "forbidden_key");
  assertEquals(({} as Record<string, unknown>).polluted, undefined);
});

Deno.test("allowed prototype keys become own properties", () => {
  const value = parseJsonBounded('{"__proto__":{"polluted":true}}', {
    ...LIMITS,
    allowPrototypeKeys: true,
  }) as Record<string, unknown>;
  assert(Object.hasOwn(value, "__proto__"), "own __proto__ property");
  assertEquals(Object.getPrototypeOf(value), Object.prototype);
  assertEquals((value as { polluted?: unknown }).polluted, undefined);
  assertEquals(({} as Record<string, unknown>).polluted, undefined);
});

Deno.test("limits are validated", () => {
  for (
    const limits of [
      { maxDepth: Number.NaN, maxKeys: 1, maxItems: 1 },
      { maxDepth: 1, maxKeys: -1, maxItems: 1 },
      { maxDepth: 1, maxKeys: 1, maxItems: Number.POSITIVE_INFINITY },
      { maxDepth: 1, maxKeys: 1, maxItems: 1, maxBytes: 1.5 },
      { maxDepth: 100_000, maxKeys: 1, maxItems: 1 },
    ]
  ) {
    assertThrows(() => parseJsonBounded("1", limits), RangeError);
  }
  assertThrows(
    () => parseJsonBounded(1 as unknown as string, LIMITS),
    BoundsError,
  );
});

// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

import { assert, assertEquals } from "@celld/assert";
import { type Path, v } from "@celld/sieve";
import { defOf } from "@celld/sieve/introspect";
import { toJSONSchema } from "@celld/sieve/json-schema";
import { issues } from "./fixture.ts";

function jsonIssue(path: Path, received: string, message: string) {
  return { code: "invalid_type", expected: "JSON", received, path, message };
}

Deno.test("json accepts plain JSON and returns it unchanged", () => {
  const Json = v.json();
  for (
    const value of [
      null,
      true,
      0,
      -1.5,
      "",
      "text",
      [],
      {},
      [1, "a", null, { b: [false] }],
      { a: { b: { c: [1, 2, 3] } }, "odd key": null },
    ]
  ) {
    assertEquals(Json.parse(value), value);
  }
  const object = { a: [1] };
  assert(Json.parse(object) === object, "the same object");
  const bare = Object.assign(Object.create(null), { a: 1 });
  assert(Json.parse(bare) === bare, "a null-prototype object");
  const shared = { x: 1 };
  assert(
    Json.is({ left: shared, right: shared, list: [shared, shared] }),
    "shared references",
  );
});

Deno.test("json rejects scalars JSON cannot hold", () => {
  const Json = v.json();
  assertEquals(issues(Json, undefined), [
    jsonIssue(
      [],
      "undefined",
      "undefined is not JSON; omit the key or use null",
    ),
  ]);
  assertEquals(issues(Json, NaN), [
    jsonIssue([], "NaN", "NaN is not a JSON number"),
  ]);
  assertEquals(issues(Json, -Infinity), [
    jsonIssue([], "Infinity", "-Infinity is not a JSON number"),
  ]);
  assertEquals(issues(Json, 1n), [
    jsonIssue([], "bigint", "a bigint is not JSON"),
  ]);
  assertEquals(issues(Json, Symbol("s")), [
    jsonIssue([], "symbol", "a symbol is not JSON"),
  ]);
  assertEquals(issues(Json, () => 1), [
    jsonIssue([], "function", "a function is not JSON"),
  ]);
});

Deno.test("json rejects non-plain objects, holes, symbol keys and cycles", () => {
  const Json = v.json();
  assertEquals(issues(Json, new Date(0)), [
    jsonIssue([], "Date", "a Date is not a plain JSON object"),
  ]);
  assertEquals(issues(Json, { m: new Map() }), [
    jsonIssue(["m"], "Map", "a Map is not a plain JSON object"),
  ]);
  class Point {
    x = 1;
  }
  assertEquals(issues(Json, [new Point()]), [
    jsonIssue([0], "Point", "a Point is not a plain JSON object"),
  ]);
  // deno-lint-ignore no-sparse-arrays
  assertEquals(issues(Json, [1, , 3]), [
    jsonIssue([1], "hole", "an array hole is not JSON"),
  ]);
  assertEquals(issues(Json, { [Symbol("k")]: 1, a: 1 }), [
    jsonIssue([], "symbol key", "symbol keys are not JSON"),
  ]);
  const cycle: Record<string, unknown> = { a: [] };
  (cycle.a as unknown[]).push({ back: cycle });
  assertEquals(issues(Json, cycle), [
    jsonIssue(["a", 0, "back"], "cycle", "cycle: the value contains itself"),
  ]);
});

Deno.test("json reports every problem with its path", () => {
  assertEquals(
    issues(v.json(), {
      ok: [1, "two"],
      bad: { deep: [undefined, NaN] },
      fn: () => {},
    }),
    [
      jsonIssue(
        ["bad", "deep", 0],
        "undefined",
        "undefined is not JSON; omit the key or use null",
      ),
      jsonIssue(["bad", "deep", 1], "NaN", "NaN is not a JSON number"),
      jsonIssue(["fn"], "function", "a function is not JSON"),
    ],
  );
  const Body = v.object({ id: v.string(), data: v.json() });
  assertEquals(issues(Body, { id: "x", data: { when: new Date(0) } }), [
    jsonIssue(["data", "when"], "Date", "a Date is not a plain JSON object"),
  ]);
  assertEquals(
    issues(v.json("not JSON"), [1n]).map((issue) => issue.message),
    ["not JSON"],
  );
});

Deno.test("json composes with refinements, has a json def and emits {}", () => {
  const Nonempty = v.json().refine(
    (value) => value !== "" && value !== null,
    "must not be empty",
  );
  assertEquals(issues(Nonempty, "").map((issue) => issue.message), [
    "must not be empty",
  ]);
  // Refinements do not run on a value that is not JSON.
  assertEquals(issues(Nonempty, undefined).map((issue) => issue.code), [
    "invalid_type",
  ]);
  assertEquals(defOf(v.json()), { kind: "json", checks: [] });
  const { $schema: _, ...rest } = toJSONSchema(v.json());
  assertEquals(rest, {});
  assertEquals(
    toJSONSchema(v.object({ data: v.json() }), { $schema: false }),
    {
      type: "object",
      properties: { data: {} },
      required: ["data"],
      additionalProperties: false,
    },
  );
});

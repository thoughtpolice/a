// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

import { assert, assertEquals } from "@celld/assert";
import { MISSING_KEY_MESSAGE, v } from "@celld/sieve";
import { issues } from "./fixture.ts";

const User = v.object({
  name: v.string().min(1),
  age: v.int().nonnegative().optional(),
  tags: v.array(v.string()).default([]),
});

Deno.test("objects strip unknown keys by default", () => {
  assertEquals(User.parse({ name: "ada", extra: 1 }), {
    name: "ada",
    tags: [],
  });
  assertEquals(User.shape.name.parse("x"), "x");
});

Deno.test("missing optional keys stay missing; present undefined stays", () => {
  const out = User.parse({ name: "ada" });
  assert(!("age" in out), "absent key is not added");
  const explicit = User.parse({ name: "ada", age: undefined });
  assert("age" in explicit && explicit.age === undefined, "present key kept");
});

Deno.test("every issue is collected with its path", () => {
  assertEquals(issues(User, { name: "", age: -1.5, tags: ["a", 2] }), [
    {
      code: "too_small",
      origin: "string",
      minimum: 1,
      inclusive: true,
      path: ["name"],
      message: "must have at least 1 character",
    },
    {
      code: "invalid_type",
      expected: "int",
      received: "number",
      path: ["age"],
      message: "expected int, received number",
    },
    {
      code: "too_small",
      origin: "number",
      minimum: 0,
      inclusive: true,
      path: ["age"],
      message: "must be at least 0",
    },
    {
      code: "invalid_type",
      expected: "string",
      received: "number",
      path: ["tags", 1],
      message: "expected string, received number",
    },
  ]);
  assertEquals(issues(User, {}), [{
    code: "invalid_type",
    expected: "string",
    received: "undefined",
    path: ["name"],
    message: "missing required key",
  }]);
  assertEquals(issues(User, [])[0].path, []);
  assertEquals(issues(User, null)[0].message, "expected object, received null");
});

Deno.test("strict, loose and catchall", () => {
  const strict = v.strictObject({ a: v.string() });
  assertEquals(strict.parse({ a: "x" }), { a: "x" });
  assertEquals(issues(strict, { a: "x", b: 1, c: 2 }), [{
    code: "unrecognized_keys",
    keys: ["b", "c"],
    path: [],
    message: 'unrecognized keys: "b", "c"',
  }]);
  assertEquals(
    issues(v.object({}).strict("no extras"), { b: 1 })[0].message,
    "no extras",
  );
  assertEquals(issues(strict, { b: 1 }).map((issue) => issue.code), [
    "invalid_type",
    "unrecognized_keys",
  ]);

  assertEquals(v.looseObject({ a: v.string() }).parse({ a: "x", b: 1 }), {
    a: "x",
    b: 1,
  });
  assertEquals(strict.loose().strip().parse({ a: "x", b: 1 }), { a: "x" });

  const counts = v.object({ total: v.int() }).catchall(v.int());
  assertEquals(counts.parse({ total: 2, a: 1, b: 1 }), {
    total: 2,
    a: 1,
    b: 1,
  });
  assertEquals(issues(counts, { total: 1, a: "x" })[0].path, ["a"]);
});

Deno.test("reshaping", () => {
  const base = v.object({ a: v.string(), b: v.int(), c: v.boolean() });
  assertEquals(Object.keys(base.pick({ a: true, c: true }).shape), ["a", "c"]);
  assertEquals(Object.keys(base.omit({ a: true }).shape), ["b", "c"]);
  assertEquals(base.partial().parse({}), {});
  assertEquals(
    issues(base.partial({ a: true }), {}).map((issue) => issue.path),
    [["b"], ["c"]],
  );
  assertEquals(issues(base.partial().required(), {}).length, 3);
  assertEquals(
    issues(base.partial().required({ b: true }), {}).map((issue) => issue.path),
    [["b"]],
  );
  const extended = base.extend({ a: v.int(), d: v.null() });
  assertEquals(extended.parse({ a: 1, b: 2, c: true, d: null }), {
    a: 1,
    b: 2,
    c: true,
    d: null,
  });
  const merged = v.object({ x: v.string() }).merge(
    v.strictObject({ y: v.int() }),
  );
  assertEquals(
    issues(merged, { x: "", y: 1, z: 0 })[0].code,
    "unrecognized_keys",
  );
  assertEquals(base.keyof().options, ["a", "b", "c"]);
});

Deno.test("reshaping drops refinements, mode changes keep them", () => {
  const checked = v.object({ a: v.int(), b: v.int() }).refine(
    (value) => value.a < value.b,
    { message: "a must be less than b", path: ["a"] },
  );
  assertEquals(issues(checked, { a: 2, b: 1 }), [{
    code: "custom",
    path: ["a"],
    message: "a must be less than b",
  }]);
  assertEquals(issues(checked.strict(), { a: 2, b: 1 })[0].code, "custom");
  assertEquals(
    checked.extend({ c: v.int().optional() }).parse({ a: 2, b: 1 }),
    { a: 2, b: 1 },
  );
});

Deno.test("__proto__ keys are data, not prototypes", () => {
  const input = JSON.parse('{"__proto__": {"admin": true}, "a": "x"}');
  const loose = v.looseObject({ a: v.string() }).parse(input) as Record<
    string,
    unknown
  >;
  assertEquals(Object.getPrototypeOf(loose), Object.prototype);
  assertEquals(loose.admin, undefined);
  assert(Object.hasOwn(loose, "__proto__"), "kept as an own key");
  const withKey = v.object({ ["__proto__"]: v.unknown() });
  assertEquals(withKey.parse({ a: 1 }), {});
});

Deno.test("class instances are objects", () => {
  class Point {
    x = 1;
  }
  assertEquals(v.object({ x: v.int() }).parse(new Point()), { x: 1 });
});

Deno.test("a missing key says so, unless its schema has its own message", () => {
  const Order = v.object({
    id: v.string(),
    kind: v.enum(["a", "b"]),
    size: v.union([v.int(), v.string()]),
    note: v.string("a note is needed"),
    item: v.object({ sku: v.string() }),
  });
  assertEquals(
    issues(Order, { item: {} }).map((issue) => [
      issue.path.join("."),
      issue.code,
      issue.message,
    ]),
    [
      ["id", "invalid_type", "missing required key"],
      ["kind", "invalid_value", "missing required key"],
      ["size", "invalid_union", "missing required key"],
      ["note", "invalid_type", "a note is needed"],
      ["item.sku", "invalid_type", "missing required key"],
    ],
  );
  // An explicit undefined is a value of the wrong type, not a missing key.
  assertEquals(
    issues(v.object({ id: v.string() }), { id: undefined })[0].message,
    "expected string, received undefined",
  );
  // A record's required enum keys are keys too.
  const Scores = v.record(v.enum(["x", "y"]), v.number());
  assertEquals(
    issues(Scores, { x: 1 }).map((issue) => [issue.path, issue.message]),
    [[["y"], "missing required key"]],
  );
  assertEquals(MISSING_KEY_MESSAGE, "missing required key");
});

Deno.test("strict objects can report each unknown key at its path", () => {
  const Point = v.strictObject({ x: v.number() }, { perKey: true });
  assertEquals(issues(Point, { x: 1, y: 2, z: 3 }), [
    {
      code: "unrecognized_keys",
      keys: ["y"],
      path: ["y"],
      message: 'unrecognized key: "y"',
    },
    {
      code: "unrecognized_keys",
      keys: ["z"],
      path: ["z"],
      message: 'unrecognized key: "z"',
    },
  ]);
  const nested = v.object({
    at: v.object({ x: v.number() }).strict({ perKey: true, message: "no" }),
  });
  assertEquals(
    issues(nested, { at: { x: 1, extra: true } }).map((issue) => [
      issue.path,
      issue.message,
    ]),
    [[["at", "extra"], "no"]],
  );
  // The default stays zod's: one issue on the object.
  assertEquals(
    issues(v.strictObject({ x: v.number() }), { x: 1, y: 2, z: 3 }),
    [{
      code: "unrecognized_keys",
      keys: ["y", "z"],
      path: [],
      message: 'unrecognized keys: "y", "z"',
    }],
  );
  // Derived shapes keep it; strip, loose and catchall drop it.
  assertEquals(
    issues(Point.extend({ w: v.number() }), { x: 1, w: 2, y: 3 })[0].path,
    ["y"],
  );
  assertEquals(
    issues(Point.strip().strict(), { x: 1, y: 3 })[0].path,
    [],
  );
  assertEquals(
    issues(v.object({}).merge(Point), { x: 1, y: 3 })[0].path,
    ["y"],
  );
  // The message is still the type error's.
  assertEquals(
    issues(
      v.strictObject({}, { message: "need an object", perKey: true }),
      1,
    )[0]
      .message,
    "need an object",
  );
});

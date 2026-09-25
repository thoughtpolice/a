// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

import { assertEquals, assertThrows } from "@celld/assert";
import { v } from "@celld/sieve";
import { issues, issuesAsync } from "./fixture.ts";

Deno.test("arrays check every element and their length", () => {
  const list = v.array(v.int()).min(2).max(3);
  assertEquals(list.parse([1, 2]), [1, 2]);
  assertEquals(list.element.parse(1), 1);
  assertEquals(issues(list, [1, "x", 3.5, 4]), [
    {
      code: "invalid_type",
      expected: "number",
      received: "string",
      path: [1],
      message: "expected number, received string",
    },
    {
      code: "invalid_type",
      expected: "int",
      received: "number",
      path: [2],
      message: "expected int, received number",
    },
    {
      code: "too_big",
      origin: "array",
      maximum: 3,
      inclusive: true,
      path: [],
      message: "must have at most 3 items",
    },
  ]);
  assertEquals(
    issues(v.array(v.int()).nonempty(), [])[0].message,
    "must have at least 1 item",
  );
  assertEquals(
    issues(v.array(v.int()).length(1), [1, 2])[0].message,
    "must have exactly 1 item",
  );
  assertEquals(
    issues(v.array(v.int()), {})[0].message,
    "expected array, received object",
  );
});

Deno.test("tuples", () => {
  const pair = v.tuple([v.string(), v.int()]);
  assertEquals(pair.parse(["a", 1]), ["a", 1]);
  assertEquals(issues(pair, ["a"]), [{
    code: "invalid_type",
    expected: "number",
    received: "undefined",
    path: [1],
    message: "expected number, received undefined",
  }]);
  assertEquals(issues(pair, ["a", 1, 2]), [{
    code: "too_big",
    origin: "array",
    maximum: 2,
    inclusive: true,
    path: [],
    message: "must have at most 2 items",
  }]);
  const rest = v.tuple([v.string()], v.boolean());
  assertEquals(rest.parse(["a", true, false]), ["a", true, false]);
  assertEquals(issues(rest, ["a", true, 1])[0].path, [2]);
  assertEquals(v.tuple([v.int(), v.int().optional()]).parse([1]), [
    1,
    undefined,
  ]);
});

Deno.test("records", () => {
  const scores = v.record(v.string().regex(/^[a-z]+$/), v.int());
  assertEquals(scores.parse({ ada: 1, bob: 2 }), { ada: 1, bob: 2 });
  assertEquals(issues(scores, { Ada: 1, bob: "x" }), [
    {
      code: "invalid_key",
      origin: "record",
      issues: [{
        code: "invalid_format",
        format: "regex",
        pattern: "/^[a-z]+$/",
        path: [],
        message: "must match /^[a-z]+$/",
      }],
      path: ["Ada"],
      message: "invalid key: must match /^[a-z]+$/",
    },
    {
      code: "invalid_type",
      expected: "number",
      received: "string",
      path: ["bob"],
      message: "expected number, received string",
    },
  ]);
  const flags = v.record(v.enum(["a", "b"]), v.boolean());
  assertEquals(flags.parse({ a: true, b: false }), { a: true, b: false });
  assertEquals(issues(flags, { a: true }).map((issue) => issue.path), [["b"]]);
  assertEquals(
    issues(flags, { a: true, b: true, c: true })[0].code,
    "invalid_key",
  );
  assertEquals(v.record(v.string().trim(), v.int()).parse({ " a ": 1 }), {
    a: 1,
  });
  const partial = v.record(v.enum(["a", "b"]), v.int().optional());
  assertEquals(partial.parse({ a: 1 }), { a: 1 });
});

Deno.test("maps and sets", () => {
  const index = v.map(v.string(), v.int());
  const input = new Map([["a", 1]]);
  assertEquals([...index.parse(input)], [["a", 1]]);
  assertEquals(issues(index, new Map<unknown, unknown>([["a", "x"], [2, 1]])), [
    {
      code: "invalid_type",
      expected: "number",
      received: "string",
      path: ["a"],
      message: "expected number, received string",
    },
    {
      code: "invalid_key",
      origin: "map",
      issues: [{
        code: "invalid_type",
        expected: "string",
        received: "number",
        path: [],
        message: "expected string, received number",
      }],
      path: [2],
      message: "invalid key: expected string, received number",
    },
  ]);
  assertEquals(issues(index, {})[0].message, "expected Map, received object");
  const tags = v.set(v.string().toLowerCase());
  assertEquals([...tags.parse(new Set(["A", "b"]))], ["a", "b"]);
  assertEquals(issues(tags, new Set(["a", 1]))[0].path, [1]);
  assertEquals(issues(tags, ["a"])[0].message, "expected Set, received array");
});

Deno.test("unions pick the first match and explain failures", () => {
  const id = v.union([v.int(), v.uuid()]);
  assertEquals(id.parse(1), 1);
  assertEquals(id.options.length, 2);
  assertEquals(issues(id, true), [{
    code: "invalid_union",
    errors: [
      [{
        code: "invalid_type",
        expected: "number",
        received: "boolean",
        path: [],
        message: "expected number, received boolean",
      }],
      [{
        code: "invalid_type",
        expected: "string",
        received: "boolean",
        path: [],
        message: "expected string, received boolean",
      }],
    ],
    path: [],
    message: "no union option matched",
  }]);
  assertEquals(issues(id, "nope"), [{
    code: "invalid_format",
    format: "uuid",
    path: [],
    message: "invalid UUID",
  }]);
  const first = v.union([v.string().transform(() => "first"), v.string()]);
  assertEquals(first.parse("x"), "first");
  assertEquals(
    issues(v.union([v.int(), v.string()], "int or string"), null)[0].message,
    "int or string",
  );
});

Deno.test("discriminated unions dispatch on the tag", () => {
  const Shape = v.discriminatedUnion("kind", [
    v.object({ kind: v.literal("circle"), radius: v.number().positive() }),
    v.object({ kind: v.enum(["square", "box"]), side: v.number() }),
  ]);
  assertEquals(Shape.parse({ kind: "box", side: 2 }), { kind: "box", side: 2 });
  assertEquals(Shape.discriminator, "kind");
  assertEquals(issues(Shape, { kind: "circle", radius: -1 })[0].path, [
    "radius",
  ]);
  assertEquals(issues(Shape, { kind: "hexagon" }), [{
    code: "invalid_union",
    errors: [],
    discriminator: "kind",
    options: ["circle", "square", "box"],
    path: ["kind"],
    message: 'unknown kind; expected "circle" | "square" | "box"',
  }]);
  assertEquals(issues(Shape, "circle")[0].code, "invalid_type");
  assertThrows(
    () => v.discriminatedUnion("kind", [v.object({ kind: v.string() })]),
    Error,
    "literal or enum",
  );
  assertThrows(
    () =>
      v.discriminatedUnion("kind", [
        v.object({ kind: v.literal("a") }),
        v.object({ kind: v.literal("a") }),
      ]),
    Error,
    "used twice",
  );
});

Deno.test("an unknown tag inside a union is reported, not buried", async () => {
  const Shape = v.discriminatedUnion("kind", [
    v.object({ kind: v.literal("circle"), radius: v.number() }),
    v.object({ kind: v.literal("square"), side: v.number() }),
  ]);
  const unknown = [{
    code: "invalid_union",
    errors: [],
    discriminator: "kind",
    options: ["circle", "square"],
    path: ["kind"],
    message: 'unknown kind; expected "circle" | "square"',
  }];
  // One shape or a list of them: an object with an unknown tag got further
  // than the list option, so its issue is the one reported.
  const OneOrMany = v.union([Shape, v.array(Shape)]);
  assertEquals(issues(OneOrMany, { kind: "hexagon" }), unknown);
  assertEquals(issues(OneOrMany, [{ kind: "hexagon" }]), [{
    ...unknown[0],
    path: [0, "kind"],
  }]);
  // It composes: a union holding that union reports it too, as does an
  // async parse.
  assertEquals(
    issues(v.union([v.string(), OneOrMany]), { kind: "hexagon" }),
    unknown,
  );
  const slow = v.union([
    Shape,
    v.array(Shape).refine(async () => await Promise.resolve(true)),
  ]);
  assertEquals(await issuesAsync(slow, { kind: "hexagon" }), unknown);
  // A tag that is known to one option still beats an unknown one elsewhere.
  const Other = v.discriminatedUnion("type", [
    v.object({ type: v.literal("dot") }),
  ]);
  assertEquals(
    issues(v.union([Other, Shape]), { kind: "circle", radius: "x" })[0].path,
    ["radius"],
  );
  // Two unknown tags are as ambiguous as before: one invalid_union.
  const both = issues(v.union([Other, Shape]), { kind: "hexagon" });
  assertEquals(both.length, 1);
  assertEquals(both[0].message, "no union option matched");
  assertEquals(both[0].code === "invalid_union" && both[0].errors.length, 2);
});

Deno.test("intersections merge outputs", () => {
  const both = v.intersection(
    v.object({ a: v.string() }),
    v.object({ b: v.int() }),
  );
  assertEquals(both.parse({ a: "x", b: 1, c: 2 }), { a: "x", b: 1 });
  assertEquals(issues(both, { a: 1 }).map((issue) => issue.path), [["a"], [
    "b",
  ]]);
  const conflicting = v.intersection(
    v.object({ a: v.string().trim() }),
    v.object({ a: v.string() }),
  );
  assertEquals(conflicting.parse({ a: "x" }), { a: "x" });
  assertEquals(issues(conflicting, { a: " x" }), [{
    code: "invalid_intersection",
    path: ["a"],
    message: "intersection results could not be merged",
  }]);
  assertEquals(v.intersection(v.int().min(1), v.int().max(3)).parse(2), 2);
});

type Tree = { value: number; children: Tree[] };
const Tree: v.Schema<Tree> = v.object({
  value: v.number(),
  children: v.array(v.lazy(() => Tree)),
});

Deno.test("lazy schemas recurse", () => {
  const input = { value: 1, children: [{ value: 2, children: [] }] };
  assertEquals(Tree.parse(input), input);
  assertEquals(
    issues(Tree, { value: 1, children: [{ value: "x", children: [] }] })[0]
      .path,
    ["children", 0, "value"],
  );
  let built = 0;
  const once = v.lazy(() => {
    built++;
    return v.int();
  });
  once.parse(1);
  once.parse(2);
  assertEquals([built, once.schema.parse(3)], [1, 3]);
});

Deno.test("array holes are undefined elements", () => {
  // deno-lint-ignore no-sparse-arrays
  const sparse = ["a", , "c"];
  assertEquals(issues(v.array(v.string()), sparse), [{
    code: "invalid_type",
    expected: "string",
    received: "undefined",
    path: [1],
    message: "expected string, received undefined",
  }]);
  const filled = v.array(v.string().optional()).parse(sparse);
  assertEquals(filled, ["a", undefined, "c"]);
  assertEquals(1 in filled, true);
  assertEquals(
    issues(v.array(v.json()), sparse)[0].message,
    "undefined is not JSON; omit the key or use null",
  );
});

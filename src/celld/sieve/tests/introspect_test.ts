// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

import { assert, assertEquals } from "@celld/assert";
import { v } from "@celld/sieve";
import {
  childrenOf,
  DEF_VERSION,
  defOf,
  idOf,
  isSchema,
  resolveLazy,
  transforms,
  walk,
} from "@celld/sieve/introspect";

Deno.test("defs are plain descriptors", () => {
  assertEquals(DEF_VERSION, 1);
  const name = v.string().min(1, "required").email().trim();
  assertEquals(defOf(name), {
    kind: "string",
    coerce: false,
    checks: [
      { check: "min_length", value: 1, message: "required" },
      { check: "format", format: "email" },
      { check: "trim" },
    ],
  });
  assertEquals(defOf(v.datetime({ offset: true, precision: 3 })).checks, [
    { check: "format", format: "datetime", offset: true, precision: 3 },
  ]);
  assertEquals(defOf(v.int().gt(0)).checks, [
    { check: "int" },
    { check: "min", value: 0, inclusive: false },
  ]);
  const refined = defOf(v.int().refine((n) => n > 0, "positive"));
  assertEquals(refined.checks.map((check) => [check.check, check.message]), [
    ["int", undefined],
    ["refine", "positive"],
  ]);
  const transform = defOf(v.string().transform(Number));
  assert(
    transform.kind === "pipe" && transform.out.def.kind === "transform",
    "marked",
  );
  const withDefault = defOf(v.int().default(3));
  assert(withDefault.kind === "default", "default");
  assertEquals(
    [withDefault.value, withDefault.factory, withDefault.inner.def.kind],
    [3, undefined, "number"],
  );
  assertEquals(idOf(v.string().meta({ id: "Name" })), "Name");
  assert(isSchema(v.never()) && !isSchema({ def: {} }), "isSchema");
});

Deno.test("children are labelled edges", () => {
  const Shape = v.object({ a: v.string(), b: v.array(v.int()) }).catchall(
    v.boolean(),
  );
  assertEquals(
    childrenOf(Shape).map((
      edge,
    ) => [edge.role, edge.key, edge.schema.def.kind]),
    [
      ["shape", "a", "string"],
      ["shape", "b", "array"],
      ["catchall", undefined, "boolean"],
    ],
  );
  assertEquals(
    childrenOf(v.tuple([v.string()], v.int())).map((
      edge,
    ) => [edge.role, edge.key]),
    [["item", 0], ["rest", undefined]],
  );
  assertEquals(
    childrenOf(v.string().pipe(v.int())).map((edge) => edge.role),
    ["in", "out"],
  );
  assertEquals(childrenOf(v.string()), []);
});

Deno.test("walk visits each schema once and ends on recursion", () => {
  type Tree = { children: Tree[] };
  const Tree: v.Schema<Tree> = v.object({
    children: v.array(v.lazy(() => Tree)),
  }).meta({ id: "Tree" });
  const seen: string[] = [];
  walk(Tree, (schema, trail) => {
    seen.push(
      `${
        trail.map((edge) => edge.key ?? edge.role).join("/")
      }:${schema.def.kind}`,
    );
  });
  assertEquals(seen, [":object", "children:array", "children/element:lazy"]);
  const skipped: string[] = [];
  walk(v.object({ a: v.object({ b: v.string() }) }), (schema) => {
    skipped.push(schema.def.kind);
    return schema.def.kind === "object" && skipped.length > 1
      ? false
      : undefined;
  });
  assertEquals(skipped, ["object", "object"]);
  assertEquals(resolveLazy(v.lazy(() => v.lazy(() => Tree))), Tree);
});

Deno.test("transforms finds anything that changes the value", () => {
  assert(
    !transforms(
      v.object({ a: v.string().min(1), b: v.array(v.int()).optional() }),
    ),
    "plain",
  );
  assert(transforms(v.object({ a: v.string().trim() })), "rewrite");
  assert(transforms(v.array(v.int().default(0))), "default");
  assert(transforms(v.coerce.number()), "coerce");
  assert(transforms(v.string().transform(Number)), "transform");
});

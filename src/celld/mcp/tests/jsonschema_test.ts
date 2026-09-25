// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

import { assert, assertEquals } from "@celld/assert";
import { compileSchema, mcpHeader, SchemaError } from "@celld/mcp";
import { v } from "@celld/sieve";
import { toJSONSchema } from "@celld/sieve/json-schema";

function errors(schema: unknown, value: unknown): string[] {
  return compileSchema(schema).validate(value).map((issue) =>
    `${issue.path.join(".") || "/"}: ${issue.message}`
  );
}

function refused(schema: unknown): string[] {
  try {
    compileSchema(schema);
  } catch (error) {
    assert(error instanceof SchemaError, `not a SchemaError: ${error}`);
    return error.issues.map((issue) =>
      `${issue.path.join("/") || "/"}: ${issue.message}`
    );
  }
  throw new Error("compiled");
}

Deno.test("types, enum and const", () => {
  assertEquals(errors({ type: "integer" }, 1), []);
  assertEquals(errors({ type: "integer" }, 1.5), [
    "/: expected integer, got a number",
  ]);
  assertEquals(errors({ type: "number" }, 2), []);
  assertEquals(errors({ type: ["string", "null"] }, null), []);
  assertEquals(errors({ enum: ["a", { b: 1 }] }, { b: 1 }), []);
  assertEquals(errors({ enum: ["a"] }, "b"), ['/: must be one of "a"']);
  assertEquals(errors({ const: [1, 2] }, [1, 2]), []);
  assertEquals(errors(true, "anything"), []);
  assertEquals(errors(false, 1), ["/: no value is allowed here"]);
});

Deno.test("numbers, strings and arrays", () => {
  const number = { minimum: 1, exclusiveMaximum: 10, multipleOf: 0.5 };
  assertEquals(errors(number, 9.5), []);
  assertEquals(errors(number, 10), ["/: must be < 10"]);
  assertEquals(errors(number, 1.25), ["/: must be a multiple of 0.5"]);
  assertEquals(errors({ minLength: 2, pattern: "^a" }, "é"), [
    "/: must be at least 2 characters",
    '/: must match the pattern "^a"',
  ]);
  // Length counts code points, not UTF-16 units.
  assertEquals(errors({ maxLength: 1 }, "😀"), []);
  const array = {
    prefixItems: [{ type: "string" }],
    items: { type: "integer" },
    minItems: 1,
    uniqueItems: true,
    contains: { const: 3 },
    maxContains: 1,
  };
  assertEquals(errors(array, ["a", 3, 4]), []);
  assertEquals(errors(array, [1, 3, 3]), [
    "/: items must be unique",
    "0: expected string, got a number",
    "/: must contain at most 1 matching items",
  ]);
});

Deno.test("objects", () => {
  const schema = {
    type: "object",
    properties: { a: { type: "string" } },
    patternProperties: { "^x-": { type: "integer" } },
    additionalProperties: false,
    required: ["a"],
    dependentRequired: { b: ["c"] },
    propertyNames: { maxLength: 3 },
  };
  assertEquals(errors(schema, { a: "x", "x-1": 1 }), []);
  assertEquals(errors(schema, { "x-1": "no", zz: 1 }), [
    "a: is required",
    "x-1: expected integer, got a string",
    "zz: is not allowed",
  ]);
  assertEquals(errors(schema, { a: "x", long: 1 }), [
    "long: is not an allowed property name",
    "long: is not allowed",
  ]);
  assertEquals(
    errors({ dependentRequired: { b: ["c"] } }, { b: 1 }),
    ["c: is required when b is present"],
  );
});

Deno.test("composition and conditionals", () => {
  assertEquals(
    errors({ anyOf: [{ type: "string" }, { type: "integer" }] }, 1),
    [],
  );
  assertEquals(
    errors({ oneOf: [{ type: "number" }, { type: "integer" }] }, 1),
    ["/: matches 2 schemas in oneOf, expected exactly 1"],
  );
  assertEquals(errors({ not: { type: "null" } }, null), [
    "/: must not match the schema in not",
  ]);
  const conditional = {
    if: { properties: { kind: { const: "a" } } },
    then: { required: ["a"] },
    else: { required: ["b"] },
  };
  assertEquals(errors(conditional, { kind: "a", a: 1 }), []);
  assertEquals(errors(conditional, { kind: "z" }), ["b: is required"]);
});

Deno.test("local references, including recursion and anchors", () => {
  const tree = {
    $defs: {
      node: {
        type: "object",
        properties: {
          children: { type: "array", items: { $ref: "#/$defs/node" } },
        },
        additionalProperties: false,
      },
      leaf: { $anchor: "leaf", type: "string" },
    },
    type: "object",
    properties: { root: { $ref: "#/$defs/node" }, name: { $ref: "#leaf" } },
  };
  assertEquals(
    errors(tree, { root: { children: [{ children: [] }] }, name: "x" }),
    [],
  );
  assertEquals(errors(tree, { root: { children: [{ extra: 1 }] } }), [
    "root.children.0.extra: is not allowed",
  ]);
  // An infinitely recursive reference is bounded, not a stack overflow.
  assertEquals(errors({ $ref: "#" }, 1), ["/: $ref nesting exceeded 64"]);
});

Deno.test("unsupported and unsafe schemas are refused up front", () => {
  assertEquals(refused({ $ref: "https://example.com/s.json" }), [
    "$ref: non-local $ref is not dereferenced: https://example.com/s.json",
  ]);
  assertEquals(refused({ $ref: "#/$defs/missing" }), [
    "$ref: does not resolve within the schema: #/$defs/missing",
  ]);
  assertEquals(refused({ unevaluatedProperties: false }), [
    "unevaluatedProperties: is not supported by this validator",
  ]);
  assertEquals(
    refused({ $schema: "http://json-schema.org/draft-07/schema#" }),
    [
      '$schema: unsupported dialect "http://json-schema.org/draft-07/schema#"; only https://json-schema.org/draft/2020-12/schema is supported',
    ],
  );
  assertEquals(refused({ type: "bogus" }), [
    "type: must be a type name or a non-empty array of them",
  ]);
  assertEquals(refused({ pattern: "(" }), [
    "pattern: is not a valid regular expression",
  ]);
  assertEquals(refused({ anyOf: [] }), [
    "anyOf: must be a non-empty array of schemas",
  ]);
  assertEquals(refused({ minLength: -1 }), [
    "minLength: must be a non-negative integer",
  ]);
  let deep: unknown = { type: "string" };
  for (let depth = 0; depth < 40; depth++) deep = { not: deep };
  assertEquals(refused(deep).length, 1);
  const wide = {
    anyOf: Array.from({ length: 3000 }, () => ({ type: "string" })),
  };
  assertEquals(refused(wide), ["anyOf/1999: more than 2000 subschemas"]);
  // Annotations and unknown keywords are fine.
  compileSchema({
    $schema: "https://json-schema.org/draft/2020-12/schema",
    title: "t",
    format: "email",
    "x-mcp-header": "X",
    "x-anything": { nested: true },
  });
});

Deno.test("validation work is bounded", () => {
  const nested = { anyOf: [{ anyOf: [{ anyOf: [{ type: "string" }] }] }] };
  const schema = compileSchema(
    { type: "array", items: nested },
    { maxSteps: 50 },
  );
  assertEquals(schema.validate(Array.from({ length: 5 }, () => "x")), []);
  assertEquals(
    schema.validate(Array.from({ length: 100 }, () => "x")).map((i) =>
      i.message
    ),
    ["validation exceeded 50 steps"],
  );
});

Deno.test("a sieve schema's JSON Schema compiles and agrees with it", () => {
  const input = v.strictObject({
    region: mcpHeader(v.string().describe("Where"), "Region"),
    limit: v.int().min(1).optional(),
    mode: v.enum(["fast", "slow"]),
    tags: v.array(v.string()).max(3),
    note: v.string().nullable(),
  });
  const value: v.Infer<typeof input> = {
    region: "eu",
    mode: "fast",
    tags: [],
    note: null,
  };
  const json = toJSONSchema(input, { io: "input", $schema: false });
  assertEquals(json, {
    type: "object",
    properties: {
      region: {
        type: "string",
        description: "Where",
        "x-mcp-header": "Region",
      },
      limit: { type: "integer", minimum: 1 },
      mode: { type: "string", enum: ["fast", "slow"] },
      tags: { type: "array", items: { type: "string" }, maxItems: 3 },
      note: { type: ["string", "null"] },
    },
    required: ["region", "mode", "tags", "note"],
    additionalProperties: false,
  });
  const compiled = compileSchema(json);
  assertEquals(compiled.validate(value), []);
  assertEquals(
    compiled.validate({ ...value, limit: 0 }).map((i) => i.message),
    ["must be >= 1"],
  );
  assertEquals(input.safeParse({ ...value, limit: 0 }).success, false);
});

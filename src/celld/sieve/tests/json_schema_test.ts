// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

import { assert, assertEquals, assertThrows } from "@celld/assert";
import { type AnySchema, v } from "@celld/sieve";
import {
  type JsonSchema as JsonObject,
  toJSONSchema,
  toJSONSchemaBundle,
} from "@celld/sieve/json-schema";
import { CIDR_V4_PATTERN, CIDR_V6_PATTERN } from "@celld/ip/patterns";
import { JWT_PATTERN } from "@celld/jwt";
import { ULID_PATTERN } from "@celld/ulid";

const DRAFT = "https://json-schema.org/draft/2020-12/schema";

function body(schema: AnySchema, io: "input" | "output" = "output") {
  const { $schema, ...rest } = toJSONSchema(schema, { io });
  assertEquals($schema, DRAFT);
  return rest;
}

Deno.test("primitives", () => {
  assertEquals(body(v.string()), { type: "string" });
  assertEquals(body(v.number()), { type: "number" });
  assertEquals(body(v.int()), { type: "integer" });
  assertEquals(body(v.boolean()), { type: "boolean" });
  assertEquals(body(v.null()), { type: "null" });
  assertEquals(body(v.unknown()), {});
  assertEquals(body(v.never()), { not: {} });
  assertEquals(body(v.literal("a")), { type: "string", const: "a" });
  assertEquals(body(v.literal([1, 2])), { type: "number", enum: [1, 2] });
  assertEquals(body(v.literal(["a", null])), { enum: ["a", null] });
  assertEquals(body(v.enum(["x", "y"])), { type: "string", enum: ["x", "y"] });
});

Deno.test("string checks and formats", () => {
  assertEquals(body(v.string().min(1).max(10).regex(/^[a-z]+$/)), {
    type: "string",
    minLength: 1,
    maxLength: 10,
    pattern: "^[a-z]+$",
  });
  assertEquals(body(v.string().length(4)), {
    type: "string",
    minLength: 4,
    maxLength: 4,
  });
  assertEquals(body(v.string().startsWith("a.b").endsWith("$")), {
    type: "string",
    pattern: "^a\\.b",
    allOf: [{ pattern: "\\$$" }],
  });
  assertEquals(body(v.email()), { type: "string", format: "email" });
  assertEquals(body(v.url()), { type: "string", format: "uri" });
  assertEquals(body(v.uuid()), { type: "string", format: "uuid" });
  assertEquals(body(v.datetime({ offset: true })), {
    type: "string",
    format: "date-time",
  });
  assertEquals(body(v.isoDate()), { type: "string", format: "date" });
  assertEquals(body(v.ipv4()), { type: "string", format: "ipv4" });
  assertEquals(body(v.ipv6()), { type: "string", format: "ipv6" });
  assertEquals(body(v.base64()), { type: "string", contentEncoding: "base64" });
  assertEquals(body(v.hex()), { type: "string", pattern: "^[0-9a-fA-F]*$" });
  assertEquals(body(v.string().trim().refine(() => true)), { type: "string" });
});

Deno.test("time, duration, and patterns for ulid, cidr and jwt", () => {
  assertEquals(body(v.iso.time()), { type: "string", format: "time" });
  assertEquals(body(v.iso.duration()), { type: "string", format: "duration" });
  assertEquals(body(v.iso.date()), { type: "string", format: "date" });
  assertEquals(body(v.iso.datetime()), { type: "string", format: "date-time" });
  const cases: [AnySchema, string, string, string][] = [
    [
      v.ulid(),
      "01ARYZ6S41TSV4RRFFQ69G5FAV",
      "81ARYZ6S41TSV4RRFFQ69G5FAV",
      ULID_PATTERN,
    ],
    [v.cidrv4(), "10.0.0.0/8", "10.0.0.0/33", CIDR_V4_PATTERN],
    [v.cidrv6(), "2001:db8::/32", "2001:db8::/129", CIDR_V6_PATTERN],
    [v.jwt(), "eyJhbGciOiJIUzI1NiJ9.e30.c2ln", "a.b", JWT_PATTERN],
  ];
  for (const [schema, good, bad, pattern] of cases) {
    const out = body(schema);
    assertEquals(out, { type: "string", pattern });
    const regex = new RegExp(out.pattern as string);
    assert(regex.test(good) && !regex.test(bad), pattern);
  }
  assertEquals(body(v.ulid().min(26)), {
    type: "string",
    minLength: 26,
    pattern: ULID_PATTERN,
  });
});

Deno.test("number checks", () => {
  assertEquals(body(v.number().min(0).lt(10).multipleOf(0.5)), {
    type: "number",
    minimum: 0,
    exclusiveMaximum: 10,
    multipleOf: 0.5,
  });
  assertEquals(body(v.int().positive()), {
    type: "integer",
    exclusiveMinimum: 0,
  });
});

Deno.test("objects, per unknown-key mode and io", () => {
  const User = v.object({
    name: v.string().describe("Display name"),
    age: v.int().optional(),
    role: v.enum(["admin", "user"]).default("user"),
  });
  assertEquals(body(User), {
    type: "object",
    properties: {
      name: { type: "string", description: "Display name" },
      age: { type: "integer" },
      role: { type: "string", enum: ["admin", "user"], default: "user" },
    },
    required: ["name", "role"],
    additionalProperties: false,
  });
  assertEquals(body(User, "input"), {
    type: "object",
    properties: {
      name: { type: "string", description: "Display name" },
      age: { type: "integer" },
      role: { type: "string", enum: ["admin", "user"], default: "user" },
    },
    required: ["name"],
  });
  assertEquals(body(v.strictObject({}), "input"), {
    type: "object",
    properties: {},
    additionalProperties: false,
  });
  assertEquals(body(v.looseObject({})), { type: "object", properties: {} });
  assertEquals(body(v.object({}).catchall(v.int())), {
    type: "object",
    properties: {},
    additionalProperties: { type: "integer" },
  });
});

Deno.test("arrays, tuples and records", () => {
  assertEquals(body(v.array(v.string()).min(1).max(3)), {
    type: "array",
    items: { type: "string" },
    minItems: 1,
    maxItems: 3,
  });
  assertEquals(body(v.tuple([v.string(), v.int().optional()])), {
    type: "array",
    prefixItems: [{ type: "string" }, { type: "integer" }],
    items: false,
    minItems: 1,
  });
  assertEquals(body(v.tuple([v.string()], v.boolean())), {
    type: "array",
    prefixItems: [{ type: "string" }],
    items: { type: "boolean" },
    minItems: 1,
  });
  assertEquals(body(v.record(v.string(), v.int())), {
    type: "object",
    additionalProperties: { type: "integer" },
  });
  assertEquals(body(v.record(v.string().regex(/^x/), v.int())), {
    type: "object",
    propertyNames: { type: "string", pattern: "^x" },
    additionalProperties: { type: "integer" },
  });
  assertEquals(body(v.record(v.enum(["a", "b"]), v.boolean())), {
    type: "object",
    propertyNames: { type: "string", enum: ["a", "b"] },
    required: ["a", "b"],
    additionalProperties: { type: "boolean" },
  });
});

Deno.test("nullable, unions and intersections", () => {
  assertEquals(body(v.string().nullable()), { type: ["string", "null"] });
  assertEquals(body(v.enum(["a"]).nullable()), {
    anyOf: [{ type: "string", enum: ["a"] }, { type: "null" }],
  });
  assertEquals(body(v.union([v.string(), v.int()])), {
    anyOf: [{ type: "string" }, { type: "integer" }],
  });
  assertEquals(
    body(v.discriminatedUnion("kind", [
      v.object({ kind: v.literal("a") }),
      v.object({ kind: v.literal("b"), n: v.int() }),
    ])),
    {
      oneOf: [
        {
          type: "object",
          properties: { kind: { type: "string", const: "a" } },
          required: ["kind"],
          additionalProperties: false,
        },
        {
          type: "object",
          properties: {
            kind: { type: "string", const: "b" },
            n: { type: "integer" },
          },
          required: ["kind", "n"],
          additionalProperties: false,
        },
      ],
    },
  );
  assertEquals(body(v.intersection(v.int(), v.number().max(3))), {
    allOf: [{ type: "integer" }, { type: "number", maximum: 3 }],
  });
});

Deno.test("wrappers, pipes and metadata", () => {
  assertEquals(body(v.array(v.int()).readonly()), {
    type: "array",
    items: { type: "integer" },
    readOnly: true,
  });
  assertEquals(body(v.int().catch(0)), { type: "integer" });
  const toNumber = v.string().regex(/^\d+$/).transform(Number).pipe(
    v.int().max(9),
  );
  assertEquals(body(toNumber, "input"), { type: "string", pattern: "^\\d+$" });
  assertEquals(body(toNumber), { type: "integer", maximum: 9 });
  assertEquals(body(v.preprocess(String, v.string()), "input"), {
    type: "string",
  });
  assertEquals(
    body(
      v.string().meta({
        title: "T",
        description: "D",
        examples: ["x"],
        "x-extra": 1,
      }),
    ),
    {
      type: "string",
      title: "T",
      description: "D",
      examples: ["x"],
      "x-extra": 1,
    },
  );
  assertEquals(body(v.string().optional().describe("outer")), {
    type: "string",
    description: "outer",
  });
});

Deno.test("recursion through lazy uses $ref", () => {
  type Tree = { value: number; children: Tree[] };
  const Tree: v.Schema<Tree> = v.object({
    value: v.number(),
    children: v.array(v.lazy(() => Tree)),
  });
  assertEquals(body(Tree), {
    type: "object",
    properties: {
      value: { type: "number" },
      children: { type: "array", items: { $ref: "#" } },
    },
    required: ["value", "children"],
    additionalProperties: false,
  });

  type Node = { next: Node | null };
  const Node: v.Schema<Node> = v.lazy(() =>
    v.object({ next: Node.nullable() })
  );
  assertEquals(body(Node), {
    type: "object",
    properties: { next: { anyOf: [{ $ref: "#" }, { type: "null" }] } },
    required: ["next"],
    additionalProperties: false,
  });

  const Wrapper = v.object({ tree: v.lazy(() => Tree) });
  assertEquals(toJSONSchema(Wrapper), {
    $schema: DRAFT,
    type: "object",
    properties: { tree: { $ref: "#/$defs/schema0" } },
    required: ["tree"],
    additionalProperties: false,
    $defs: {
      schema0: {
        type: "object",
        properties: {
          value: { type: "number" },
          children: { type: "array", items: { $ref: "#/$defs/schema0" } },
        },
        required: ["value", "children"],
        additionalProperties: false,
      },
    },
  });
});

Deno.test("named schemas become $defs", () => {
  const Point = v.object({ x: v.number(), y: v.number() }).meta({
    id: "Point",
    description: "A point",
  });
  const Line = v.object({ from: Point, to: Point.optional() }).meta({
    id: "Line",
  });
  assertEquals(toJSONSchema(Line), {
    $schema: DRAFT,
    type: "object",
    properties: {
      from: { $ref: "#/$defs/Point" },
      to: { $ref: "#/$defs/Point" },
    },
    required: ["from"],
    additionalProperties: false,
    $defs: {
      Point: {
        type: "object",
        properties: { x: { type: "number" }, y: { type: "number" } },
        required: ["x", "y"],
        additionalProperties: false,
        description: "A point",
      },
    },
  });
  const Clash = v.object({ a: Point, b: v.string().meta({ id: "Point" }) });
  assertThrows(() => toJSONSchema(Clash), Error, 'named "Point"');

  assertEquals(toJSONSchemaBundle({ Line, Point, Other: v.string(), n: 1 }), {
    $schema: DRAFT,
    $defs: {
      Line: {
        type: "object",
        properties: {
          from: { $ref: "#/$defs/Point" },
          to: { $ref: "#/$defs/Point" },
        },
        required: ["from"],
        additionalProperties: false,
      },
      Point: {
        type: "object",
        properties: { x: { type: "number" }, y: { type: "number" } },
        required: ["x", "y"],
        additionalProperties: false,
        description: "A point",
      },
    },
  });
  assertEquals(Object.keys(toJSONSchemaBundle([Line]).$defs as object), [
    "Line",
    "Point",
  ]);
});

Deno.test("unrepresentable schemas throw unless asked not to", () => {
  for (
    const schema of [
      v.bigint(),
      v.date(),
      v.undefined(),
      v.bytes(),
      v.map(v.string(), v.int()),
      v.set(v.int()),
      v.int().transform(String),
      v.instanceof(Error),
      v.literal(1n),
    ]
  ) {
    assert(
      assertThrows(() => toJSONSchema(schema)).message.includes(
        "cannot be represented",
      ),
      schema.def.kind,
    );
  }
  assertEquals(
    assertThrows(() => toJSONSchema(v.object({ a: v.array(v.date()) })))
      .message,
    "sieve: date cannot be represented in JSON Schema (at #/properties/a/items)",
  );
  assertEquals(
    toJSONSchema(v.object({ when: v.date() }), { unrepresentable: "any" })
      .properties,
    { when: {} },
  );
  assert(
    assertThrows(() =>
      toJSONSchema(v.string(), { target: "draft-7" as "draft-2020-12" })
    ).message
      .includes("unsupported"),
    "target",
  );
});

Deno.test("$schema: false leaves out the URI", () => {
  assertEquals(toJSONSchema(v.string(), { $schema: false }), {
    type: "string",
  });
  assertEquals(toJSONSchema(v.string(), { $schema: true }).$schema, DRAFT);
  const Named = v.string().meta({ id: "Named" });
  assertEquals(toJSONSchemaBundle([Named], { $schema: false }), {
    $defs: { Named: { type: "string" } },
  });
});

function strict(schema: AnySchema) {
  return toJSONSchema(schema, { target: "openai-strict" });
}

function refused(schema: AnySchema): string {
  return assertThrows(() => strict(schema)).message;
}

// OpenAI's own rules for a strict schema, as `strictSchemaIssues` in
// @celld/api/openai checks them: an object root, and every object closed with
// every property required.
function strictIssues(node: unknown, path: string, out: string[]): string[] {
  if (Array.isArray(node)) {
    node.forEach((item, index) => strictIssues(item, `${path}/${index}`, out));
    return out;
  }
  if (typeof node !== "object" || node === null) return out;
  const schema = node as Record<string, unknown>;
  const isObject = schema.type === "object" ||
    (Array.isArray(schema.type) && schema.type.includes("object"));
  if (isObject) {
    if (schema.additionalProperties !== false) out.push(path);
    const required = (schema.required ?? []) as string[];
    for (const key of Object.keys(schema.properties ?? {})) {
      if (!required.includes(key)) out.push(`${path}/properties/${key}`);
    }
  }
  for (const [key, value] of Object.entries(schema)) {
    if (key !== "enum" && key !== "const" && key !== "required") {
      strictIssues(value, `${path}/${key}`, out);
    }
  }
  return out;
}

Deno.test("openai-strict: a whole schema passes OpenAI's strict rules", () => {
  const Location = v.object({
    path: v.string(),
    line: v.int().positive().nullable(),
  }).meta({ id: "Location" });
  const Finding = v.object({
    title: v.string().min(3),
    severity: v.enum(["low", "medium", "high"]),
    where: v.array(Location),
    fix: v.discriminatedUnion("kind", [
      v.object({ kind: v.literal("patch"), diff: v.string() }),
      v.strictObject({ kind: v.literal("none"), why: v.string() }),
    ]).nullable(),
    tags: v.array(v.string().default("misc")),
    score: v.number().catch(0),
  });
  const Review = v.object({ findings: v.array(Finding), location: Location });
  const json = strict(Review);
  assertEquals(strictIssues(json, "#", []), []);
  assert(!("$schema" in json), "no $schema");
  assertEquals(Object.keys(json.$defs as object), ["Location"]);
  assertEquals(json.properties, {
    findings: {
      type: "array",
      items: {
        type: "object",
        properties: {
          title: { type: "string", minLength: 3 },
          severity: { type: "string", enum: ["low", "medium", "high"] },
          where: { type: "array", items: { $ref: "#/$defs/Location" } },
          fix: {
            anyOf: [{
              anyOf: [
                {
                  type: "object",
                  properties: {
                    kind: { type: "string", const: "patch" },
                    diff: { type: "string" },
                  },
                  required: ["kind", "diff"],
                  additionalProperties: false,
                },
                {
                  type: "object",
                  properties: {
                    kind: { type: "string", const: "none" },
                    why: { type: "string" },
                  },
                  required: ["kind", "why"],
                  additionalProperties: false,
                },
              ],
            }, { type: "null" }],
          },
          tags: { type: "array", items: { type: "string" } },
          score: { type: "number" },
        },
        required: ["title", "severity", "where", "fix", "tags", "score"],
        additionalProperties: false,
      },
    },
    location: { $ref: "#/$defs/Location" },
  });
});

Deno.test("openai-strict: describes the input", () => {
  // The input side of a transform is representable; the output is not.
  assertEquals(strict(v.object({ n: v.string().transform(Number) })), {
    type: "object",
    properties: { n: { type: "string" } },
    required: ["n"],
    additionalProperties: false,
  });
  assertThrows(
    () =>
      toJSONSchema(v.object({ n: v.string().transform(Number) }), {
        target: "openai-strict",
        io: "output",
      }),
    Error,
    "cannot be represented",
  );
});

Deno.test("openai-strict: the root must be an object", () => {
  assertEquals(
    refused(v.string()),
    'sieve: openai-strict: the root has type "string", but it must be an object (at #); wrap the value in v.object({ ... }) in strict mode',
  );
  assert(
    refused(v.object({ a: v.string() }).nullable()).includes(
      'the root has type ["object","null"]',
    ),
    "nullable root",
  );
  assert(
    refused(v.union([v.object({ a: v.string() }), v.string()])).includes(
      "the root has no single type",
    ),
    "union root",
  );
  const Lazy = v.lazy(() => v.object({ a: v.string() }));
  assertEquals(strict(Lazy).type, "object");
});

Deno.test("openai-strict: every object is closed, stripping ones too", () => {
  const Stripping = v.object({ inner: v.object({ a: v.string() }) });
  const json = strict(Stripping);
  assertEquals(json.additionalProperties, false);
  assertEquals(
    (json.properties as Record<string, Record<string, unknown>>).inner
      .additionalProperties,
    false,
  );
  assertEquals(
    strict(v.strictObject({ a: v.string() })).additionalProperties,
    false,
  );
});

Deno.test("openai-strict: an object with no keys has required: []", () => {
  assertEquals(strict(v.object({ empty: v.strictObject({}) })), {
    type: "object",
    properties: {
      empty: {
        type: "object",
        properties: {},
        required: [],
        additionalProperties: false,
      },
    },
    required: ["empty"],
    additionalProperties: false,
  });
  // Draft 2020-12 leaves out an empty list.
  assertEquals(toJSONSchema(v.strictObject({}), { $schema: false }), {
    type: "object",
    properties: {},
    additionalProperties: false,
  });
});

Deno.test("openai-strict: loose objects throw", () => {
  assertEquals(
    refused(v.object({ meta: v.looseObject({ a: v.string() }) })),
    "sieve: openai-strict: a loose object allows unknown keys, but additionalProperties must be false (at #/properties/meta); use v.object() or v.strictObject() instead of v.looseObject() or .loose() in strict mode",
  );
  assert(
    refused(v.object({ a: v.string() }).loose()).includes("(at #)"),
    ".loose()",
  );
});

Deno.test("openai-strict: catchalls throw", () => {
  assertEquals(
    refused(v.object({ a: v.string() }).catchall(v.int())),
    "sieve: openai-strict: a catchall allows unknown keys, but additionalProperties must be false (at #); declare every key in the shape instead of using .catchall() in strict mode",
  );
});

Deno.test("openai-strict: records throw", () => {
  assertEquals(
    refused(v.object({ counts: v.record(v.string(), v.int()) })),
    "sieve: openai-strict: a record allows any keys, but additionalProperties must be false (at #/properties/counts); use v.object() with fixed keys instead of v.record() in strict mode",
  );
});

Deno.test("openai-strict: optional keys throw, saying to use nullable", () => {
  assertEquals(
    refused(v.object({ line: v.int().optional() })),
    'sieve: openai-strict: key "line" may be absent, but every key must be required (at #/properties/line); use .nullable() instead of .optional() in strict mode; the model sends null',
  );
  assert(
    refused(v.object({ a: v.object({ b: v.string().nullish() }) })).includes(
      "(at #/properties/a/properties/b); use .nullable() instead of .optional()",
    ),
    "nested nullish",
  );
  assertEquals(
    strict(v.object({ line: v.int().nullable() })).required,
    ["line"],
  );
});

Deno.test("openai-strict: default keys throw, saying to use nullable", () => {
  assertEquals(
    refused(v.object({ tags: v.array(v.string()).default([]) })),
    'sieve: openai-strict: key "tags" may be absent, but every key must be required (at #/properties/tags); use .nullable() instead of .default() in strict mode; the model sends null',
  );
});

Deno.test("openai-strict: catch keys are required", () => {
  const json = strict(v.object({ n: v.int().catch(0) }));
  assertEquals(json.required, ["n"]);
  assertEquals(
    toJSONSchema(v.object({ n: v.int().catch(0) }), {
      io: "input",
    }).required,
    undefined,
  );
});

Deno.test("openai-strict: discriminated unions are anyOf", () => {
  const Event = v.object({
    event: v.discriminatedUnion("type", [
      v.object({ type: v.literal("a") }),
      v.object({ type: v.literal("b") }),
    ]),
  });
  const event = (strict(Event).properties as Record<string, JsonObject>).event;
  assertEquals(Object.keys(event), ["anyOf"]);
  assert(
    "oneOf" in
      (toJSONSchema(Event).properties as Record<string, JsonObject>).event,
    "draft keeps oneOf",
  );
});

Deno.test("openai-strict: intersections throw", () => {
  assertEquals(
    refused(
      v.object({
        both: v.intersection(
          v.object({ a: v.string() }),
          v.object({ b: v.string() }),
        ),
      }),
    ),
    "sieve: openai-strict: an intersection becomes allOf, which is not supported (at #/properties/both); combine objects with .extend() or .merge() instead of v.intersection() in strict mode",
  );
});

Deno.test("openai-strict: more than one pattern throws", () => {
  assertEquals(
    refused(v.object({ id: v.string().startsWith("id_").hex() })),
    "sieve: openai-strict: a string with 2 patterns needs allOf, which is not supported (at #/properties/id); combine the pattern, format and affix checks into one .regex() in strict mode",
  );
  assertEquals(
    (strict(v.object({ id: v.string().regex(/^id_[0-9a-f]+$/) }))
      .properties as Record<string, JsonObject>).id,
    { type: "string", pattern: "^id_[0-9a-f]+$" },
  );
});

Deno.test("openai-strict: $schema, default and contentEncoding are left out", () => {
  const json = strict(
    v.object({
      data: v.base64(),
      items: v.array(v.string().default("x")),
    }),
  );
  assertEquals(json, {
    type: "object",
    properties: {
      data: { type: "string" },
      items: { type: "array", items: { type: "string" } },
    },
    required: ["data", "items"],
    additionalProperties: false,
  });
  assertEquals(
    toJSONSchema(v.object({}), { target: "openai-strict", $schema: true })
      .$schema,
    DRAFT,
  );
});

Deno.test("openai-strict: $defs and $ref are kept, recursion included", () => {
  type Node = { name: string; children: Node[] };
  const Node: v.Schema<Node> = v.object({
    name: v.string(),
    children: v.array(v.lazy(() => Node)),
  }).meta({ id: "Node" });
  const Tree = v.object({ root: Node });
  const json = strict(Tree);
  assertEquals(json.properties, { root: { $ref: "#/$defs/Node" } });
  assertEquals((json.$defs as Record<string, JsonObject>).Node, {
    type: "object",
    properties: {
      name: { type: "string" },
      children: { type: "array", items: { $ref: "#/$defs/Node" } },
    },
    required: ["name", "children"],
    additionalProperties: false,
  });
  assertEquals(strictIssues(json, "#", []), []);
});

Deno.test("refinements are described with meta", () => {
  // `v.json()` is exactly `{}`: every JSON document is a JSON value. What a
  // refinement adds is code, so JSON Schema says it through `.meta()`.
  const Entry = v.json().refine(
    (value) => typeof value === "string" && value.trim() !== "",
    "must be non-blank text",
  );
  assertEquals(toJSONSchema(Entry, { $schema: false }), {});
  assertEquals(
    toJSONSchema(Entry.meta({ type: "string", pattern: "\\S" }), {
      $schema: false,
    }),
    { type: "string", pattern: "\\S" },
  );
});

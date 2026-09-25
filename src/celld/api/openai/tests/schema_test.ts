// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

// How @celld/sieve schemas reach the model and come back: the strict JSON
// Schema of a structured format or a tool, the parse of what the model
// wrote, and the check on JSON Schemas written by hand.

import { assert, assertEquals, assertThrows } from "@celld/assert";
import {
  GptClient,
  GptError,
  GptInvalidRequestError,
  parametersSchema,
  requestIssues,
  strictSchema,
} from "@celld/api/openai";
import { FakeResponses, virtualRuntime } from "@celld/api/openai/testing";
import { type Infer, v } from "@celld/sieve";

const Finding = v.strictObject({
  title: v.string().min(3).describe("What is wrong."),
  severity: v.enum(["low", "medium", "high"]),
  line: v.int().min(1).nullable(),
  tags: v.array(v.string()).max(2),
  fixed: v.boolean(),
});

function client(fake: FakeResponses) {
  return new GptClient({
    fetch: fake.fetch,
    runtime: virtualRuntime(),
    model: "gpt-5.5",
    retry: { maxRetries: 0 },
  });
}

Deno.test("a structured format is the openai-strict schema", () => {
  assertEquals(strictSchema(Finding), {
    type: "object",
    properties: {
      title: { type: "string", minLength: 3, description: "What is wrong." },
      severity: { type: "string", enum: ["low", "medium", "high"] },
      line: { type: ["integer", "null"], minimum: 1 },
      tags: { type: "array", items: { type: "string" }, maxItems: 2 },
      fixed: { type: "boolean" },
    },
    required: ["title", "severity", "line", "tags", "fixed"],
    additionalProperties: false,
  });
  // A stripping object is closed too: the model may not add keys.
  assertEquals(
    strictSchema(v.object({ a: v.string() })).additionalProperties,
    false,
  );
});

Deno.test("a schema strict mode refuses is an invalid request", () => {
  const error = assertThrows(
    () => strictSchema(v.object({ line: v.int().optional() })),
    GptInvalidRequestError,
  );
  assertEquals(error.issues[0].path, ["format", "schema"]);
  assert(error.message.includes("use .nullable()"), error.message);
  assertThrows(
    () => strictSchema(v.array(v.string())),
    GptInvalidRequestError,
    "must be an object",
  );
});

Deno.test("structured answers are parsed by the schema, typed", async () => {
  const fake = new FakeResponses([{
    text: JSON.stringify({
      title: "sqli",
      severity: "high",
      line: null,
      tags: [],
      fixed: false,
    }),
  }]);
  const { value } = await client(fake).structured({
    input: "x",
    schema: Finding,
  });
  const typed: Infer<typeof Finding> = value;
  const line: number | null = typed.line;
  assertEquals([typed.severity, line], ["high", null]);
  assertEquals(
    (fake.requests[0].body.text as { format: { schema: unknown } }).format
      .schema,
    strictSchema(Finding),
  );
});

Deno.test("the parse is the schema's: transforms and defaults apply", async () => {
  const Due = v.strictObject({
    at: v.iso.date().toPlainDate(),
    title: v.string().trim(),
  });
  const fake = new FakeResponses([{
    text: JSON.stringify({ at: "2026-10-31", title: "  pay  " }),
  }]);
  const { value } = await client(fake).structured({ input: "x", schema: Due });
  assertEquals([value.at.month, value.title], [10, "pay"]);
  assertEquals(strictSchema(Due).properties, {
    at: { type: "string", format: "date" },
    title: { type: "string" },
  });
});

Deno.test("every problem in an answer is reported with its path", async () => {
  const fake = new FakeResponses([
    {
      text: JSON.stringify({
        title: "x",
        severity: "urgent",
        line: 0.5,
        tags: ["a", "b", 3],
        extra: 1,
      }),
    },
    { text: "{nope" },
  ]);
  const gpt = client(fake);
  const bad = await gpt.tryStructured({ input: "x", schema: Finding });
  assert(!bad.ok, "refused");
  assertEquals(bad.error.kind, "output");
  assertEquals(bad.error.issues.map((issue) => issue.path.join(".")), [
    "title",
    "severity",
    "line",
    "line",
    "tags.2",
    "tags",
    "fixed",
    "",
  ]);
  assert(
    bad.error.message.startsWith("the answer does not match the schema: "),
    bad.error.message,
  );
  const text = await gpt.tryStructured({ input: "x", schema: Finding });
  assert(!text.ok, "not JSON");
  assertEquals(text.error.issues, [
    { path: [], message: "the answer is not JSON" },
  ]);
});

Deno.test("a refusal is its own kind", async () => {
  const fake = new FakeResponses([{ refusal: "no" }]);
  const error = await client(fake).structured({ input: "x", schema: Finding })
    .then(() => null, (caught) => caught);
  assert(error instanceof GptError && error.kind === "refusal", "refusal");
});

Deno.test("tool parameters: strict by default, input form otherwise", () => {
  const params = v.strictObject({
    cmd: v.string(),
    workdir: v.string().optional(),
  });
  assertEquals(parametersSchema("run", params, false), {
    type: "object",
    properties: { cmd: { type: "string" }, workdir: { type: "string" } },
    required: ["cmd"],
    additionalProperties: false,
  });
  assertThrows(
    () => parametersSchema("run", params, true),
    TypeError,
    "tool run is strict but its parameters are not",
  );
  assertThrows(
    () => parametersSchema("run", v.string(), false),
    TypeError,
    "must be an object schema",
  );
  assertThrows(
    () => parametersSchema("run", v.object({ at: v.date() }), false),
    TypeError,
    "parameters have no JSON Schema",
  );
});

Deno.test("hand-written strict schemas are checked at any depth", () => {
  const paths = (schema: unknown) =>
    requestIssues({
      input: "x",
      format: { name: "out", schema, strict: true },
    }).map((issue) => `${issue.path.join(".")}: ${issue.message}`);
  assertEquals(paths({ type: "array" }), [
    "format.schema: the root of a strict schema must be an object schema",
  ]);
  assertEquals(
    paths({
      type: "object",
      properties: {
        inner: {
          type: "object",
          properties: { x: { type: "string" } },
          required: [],
          additionalProperties: false,
        },
      },
      required: ["inner"],
      additionalProperties: false,
    }),
    [
      "format.schema.properties.inner.properties.x: strict mode needs every property in required; use a nullable type instead",
    ],
  );
  assertEquals(paths(strictSchema(Finding)), []);
});

Deno.test("a hand-written schema must be plain JSON", () => {
  const issues = requestIssues({
    input: "x",
    format: {
      name: "out",
      strict: false,
      schema: { type: "object", default: undefined },
    },
  });
  assertEquals(issues.map((issue) => issue.path.join(".")), [
    "format.schema.default",
  ]);
});

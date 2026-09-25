// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

// The JSON Schemas the model sees: the Blue Team formats and the definition
// of every coding tool. tests/golden/model-schemas.json holds them as the
// schema builder this library had before `@celld/sieve` wrote them; the
// sieve schemas must say the same thing to the model.
//
// Two differences in form are normalized away, since they mean the same:
// the order of keys, and a nullable scalar, which the old builder wrote as
// `anyOf: [{type: t, ...}, {type: "null"}]` and sieve writes as
// `{type: [t, "null"], ...}`. Anything else must be listed in CHANGES with
// the reason, or the test fails.

import { assertEquals } from "@celld/assert";
import {
  type JsonObject,
  type JsonValue,
  toolDefinition,
} from "@celld/api/openai";
import {
  Finding,
  Location,
  ReNotes,
  SecurityReview,
  Triage,
} from "@celld/api/openai/blueteam";
import {
  applyPatchTool,
  execCommandTool,
  legacyShellTool,
  MemoryFileSystem,
  readOnlyTools,
} from "@celld/api/openai/coding";
import { scriptedShell } from "@celld/api/openai/testing";
import type { AnySchema } from "@celld/sieve";
import { toJSONSchema } from "@celld/sieve/json-schema";

/**
 * Intended differences from the golden file, applied to it before the
 * comparison: none. Add an entry (a change to the golden value, and why)
 * when a schema changes on purpose.
 */
const CHANGES: readonly {
  readonly why: string;
  readonly apply: (golden: JsonObject) => void;
}[] = [];

function strict(schema: AnySchema): JsonValue {
  return toJSONSchema(schema, { target: "openai-strict" }) as JsonValue;
}

function current(): JsonObject {
  const fs = new MemoryFileSystem();
  const shell = scriptedShell(() => ({ exitCode: 0, output: "" }));
  const tools = [
    ...readOnlyTools(fs),
    applyPatchTool(fs),
    execCommandTool(shell),
    legacyShellTool(shell),
  ];
  return JSON.parse(JSON.stringify({
    formats: {
      Location: strict(Location),
      Finding: strict(Finding),
      SecurityReview: strict(SecurityReview),
      ReNotes: strict(ReNotes),
      Triage: strict(Triage),
    },
    tools: Object.fromEntries(
      tools.map((tool) => [tool.name, toolDefinition(tool)]),
    ),
  }));
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Sorted keys, and `anyOf: [scalar, null]` as `type: [t, "null"]`. */
function normalize(value: JsonValue): JsonValue {
  if (Array.isArray(value)) return value.map(normalize);
  if (!isObject(value)) return value;
  const options = value.anyOf;
  if (
    Object.keys(value).length === 1 && Array.isArray(options) &&
    options.length === 2 && isObject(options[0]) && isObject(options[1]) &&
    Object.keys(options[1]).length === 1 && options[1].type === "null" &&
    typeof options[0].type === "string" && !("enum" in options[0]) &&
    !("const" in options[0])
  ) {
    return normalize({ ...options[0], type: [options[0].type, "null"] });
  }
  return Object.fromEntries(
    Object.keys(value).sort().map((key) => [key, normalize(value[key])]),
  );
}

function golden(): JsonObject {
  return JSON.parse(Deno.readTextFileSync(Deno.env.get("OPENAI_GOLDEN")!));
}

Deno.test("the model-facing schemas match the golden file", () => {
  const expected = golden();
  for (const change of CHANGES) change.apply(expected);
  assertEquals(normalize(current()), normalize(expected));
});

Deno.test("the golden file covers every format and coding tool", () => {
  const { formats, tools } = current() as {
    formats: JsonObject;
    tools: JsonObject;
  };
  assertEquals(Object.keys(formats), [
    "Location",
    "Finding",
    "SecurityReview",
    "ReNotes",
    "Triage",
  ]);
  assertEquals(Object.keys(tools), [
    "read_file",
    "list_dir",
    "grep_files",
    "apply_patch",
    "exec_command",
    "shell",
  ]);
  assertEquals(
    Object.keys(golden().formats as JsonObject),
    Object.keys(formats),
  );
  assertEquals(Object.keys(golden().tools as JsonObject), Object.keys(tools));
});

Deno.test("only the form of a nullable scalar changed", () => {
  const { formats } = current() as { formats: { Location: JsonObject } };
  const location = golden().formats as { Location: JsonObject };
  const line = (schema: JsonObject) =>
    (schema.properties as JsonObject).startLine;
  assertEquals(line(location.Location), {
    anyOf: [
      {
        type: "integer",
        minimum: 1,
        description: "First line (1-based), or null.",
      },
      { type: "null" },
    ],
  });
  assertEquals(line(formats.Location), {
    type: ["integer", "null"],
    minimum: 1,
    description: "First line (1-based), or null.",
  });
});

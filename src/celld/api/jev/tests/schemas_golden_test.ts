// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

// The JSON Schema bundle `sieve_json_schema` built from @celld/api/jev/schemas
// must match the golden file byte for byte. After an intended change, copy
// the built file (`buck2 build :schemas-json-schema --show-output`) over the
// golden one.

import { assertEquals } from "@celld/assert";

function read(variable: string): string {
  const path = Deno.env.get(variable);
  if (path === undefined) throw new Error(`${variable} is not set`);
  return Deno.readTextFileSync(path);
}

Deno.test("the emitted bundle matches the golden file", () => {
  const emitted = read("JEV_SCHEMA_EMITTED");
  const golden = read("JEV_SCHEMA_GOLDEN");
  assertEquals(Object.keys(JSON.parse(emitted).$defs), [
    "AskRequest",
    "ChoiceQuestion",
    "Criterion",
    "Entry",
    "ModelCard",
    "ModelList",
    "ModelName",
    "NoulQuestion",
    "Question",
    "Questions",
    "ScoreQuestion",
    "State",
    "Usage",
  ]);
  assertEquals(emitted, golden, "emitted bundle");
});

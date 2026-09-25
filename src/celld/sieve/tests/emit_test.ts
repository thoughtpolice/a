// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

// The bundle `sieve_json_schema` built from tests/fixture_api.ts must match
// the golden file byte for byte. After an intended change, copy the built
// file (`buck2 build :fixture-api-schema --show-output`) over the golden.

import { assertEquals } from "@celld/assert";

function read(variable: string): string {
  const path = Deno.env.get(variable);
  if (path === undefined) throw new Error(`${variable} is not set`);
  return Deno.readTextFileSync(path);
}

Deno.test("the emitted bundle matches the golden file", () => {
  const emitted = read("SIEVE_EMITTED");
  const golden = read("SIEVE_GOLDEN");
  assertEquals(
    Object.keys(JSON.parse(emitted).$defs),
    ["Event", "Finding", "Location", "Section", "Severity"],
  );
  assertEquals(emitted, golden, "emitted bundle");
});

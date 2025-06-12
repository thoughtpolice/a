// SPDX-FileCopyrightText: © 2024-2025 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

import { assertEquals } from "@std/assert";
import { targetDeterminationTool } from "../tools/buck2.ts";

Deno.test("target_determination tool - schema validation", () => {
  // Test valid inputs
  const validArgs = {
    from: "trunk()",
    to: "@",
    universe: ["root//src/...", "third-party//..."],
  };

  const result = targetDeterminationTool.schema.safeParse(validArgs);
  assertEquals(result.success, true);
});

Deno.test("target_determination tool - schema validation errors", () => {
  // Test missing required fields
  const invalidArgs = {
    from: "trunk()",
    // missing 'to' and 'universe'
  };

  const result = targetDeterminationTool.schema.safeParse(invalidArgs);
  assertEquals(result.success, false);
});

Deno.test("target_determination tool - empty universe validation", () => {
  // Test empty universe array
  const invalidArgs = {
    from: "trunk()",
    to: "@",
    universe: [], // empty array should fail
  };

  const result = targetDeterminationTool.schema.safeParse(invalidArgs);
  assertEquals(result.success, false);
});

Deno.test("target_determination tool - single string universe rejected", () => {
  // Test single string universe parameter should now fail
  const invalidArgs = {
    from: "trunk()",
    to: "@",
    universe: "root//src/...", // single string should now fail
  };

  const result = targetDeterminationTool.schema.safeParse(invalidArgs);
  assertEquals(result.success, false);
});

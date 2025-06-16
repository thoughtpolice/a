// SPDX-FileCopyrightText: © 2024-2025 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

import { assertEquals } from "@std/assert";
import { convertToMcpTools, TOOLS } from "../tools.ts";

// Type for JSON schema property
interface JsonSchemaProperty {
  type: string;
  description: string;
}

// Test that the modular tool system works correctly
Deno.test("Modular tool system", () => {
  // Verify that expected tools are present
  const toolNames = TOOLS.map((tool) => tool.name);

  // Manual tools
  assertEquals(toolNames.includes("source_fetch"), true);
  assertEquals(toolNames.includes("buck2_build"), true);
  assertEquals(toolNames.includes("buck2_test"), true);
  assertEquals(toolNames.includes("target_determination"), true);

  // Resource-backed tools
  assertEquals(toolNames.includes("get_config"), true);
  assertEquals(toolNames.includes("get_server_info"), true);
  assertEquals(toolNames.includes("get_buck2_targets"), true);
  assertEquals(toolNames.includes("get_buck2_target_providers"), true);
});

Deno.test("Dynamic schema conversion", () => {
  // Test that schemas are properly converted to MCP format
  const mcpTools = convertToMcpTools(TOOLS);

  // Check source_fetch tool schema
  const sourceFetchTool = mcpTools.find((tool) => tool.name === "source_fetch");
  assertEquals(sourceFetchTool?.name, "source_fetch");
  assertEquals(
    sourceFetchTool?.description,
    "Fetch source code from a repository and return the local path. Supports 'github:owner/repo' format.",
  );
  assertEquals(sourceFetchTool?.inputSchema.type, "object");
  assertEquals(sourceFetchTool?.inputSchema.required, ["url"]);
  assertEquals(
    (sourceFetchTool?.inputSchema.properties?.url as JsonSchemaProperty)?.type,
    "string",
  );

  // Check buck2_test tool schema
  const buck2TestTool = mcpTools.find((tool) => tool.name === "buck2_test");
  assertEquals(buck2TestTool?.name, "buck2_test");
  assertEquals(
    buck2TestTool?.description,
    "Run tests for Buck2 targets using buck2 test command",
  );
  assertEquals(buck2TestTool?.inputSchema.type, "object");
  assertEquals(buck2TestTool?.inputSchema.required, ["targets"]);
  assertEquals(
    (buck2TestTool?.inputSchema.properties?.targets as Record<string, unknown>)?.type,
    "array",
  );

  // Check target_determination tool schema
  const targetDeterminationTool = mcpTools.find((tool) =>
    tool.name === "target_determination"
  );
  assertEquals(targetDeterminationTool?.name, "target_determination");
  assertEquals(
    targetDeterminationTool?.description,
    "Determine which Buck2 targets need to be rebuilt based on changes between two revisions",
  );
  assertEquals(targetDeterminationTool?.inputSchema.type, "object");
  assertEquals(targetDeterminationTool?.inputSchema.required, [
    "from",
    "to",
    "universe",
  ]);
  assertEquals(
    (targetDeterminationTool?.inputSchema.properties
      ?.from as JsonSchemaProperty)?.type,
    "string",
  );
  assertEquals(
    (targetDeterminationTool?.inputSchema.properties?.to as JsonSchemaProperty)
      ?.type,
    "string",
  );
});

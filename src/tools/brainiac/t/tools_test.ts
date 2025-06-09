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
  assertEquals(sourceFetchTool?.description, "Fetch source code from a repository and return the local path. Supports 'github:owner/repo' format.");
  assertEquals(sourceFetchTool?.inputSchema.type, "object");
  assertEquals(sourceFetchTool?.inputSchema.required, ["url"]);
  assertEquals(
    (sourceFetchTool?.inputSchema.properties?.url as JsonSchemaProperty)?.type,
    "string",
  );
});

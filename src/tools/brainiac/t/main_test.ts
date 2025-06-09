// SPDX-FileCopyrightText: © 2024-2025 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

import { assertEquals } from "@std/assert";
import { convertToMcpTools, executeTool, TOOLS } from "../tools.ts";
import { convertToMcpResources, RESOURCES } from "../resources.ts";

// Test the utility functions directly - removed add and capitalize functions

// Test MCP server functionality through simulated tool calls
Deno.test("MCP server tool validation", async () => {
  // Test that the main module can be imported without errors
  const mainModule = await import("../main.ts");
  assertEquals(typeof mainModule, "object");
});

// Test MCP tool definitions and conversion
Deno.test("MCP tool definitions", () => {
  // Test that core manual tools are present
  const toolNames = TOOLS.map((t) => t.name);
  assertEquals(toolNames.includes("source_fetch"), true);

  // Test that resource-backed tools are present
  assertEquals(toolNames.includes("get_config"), true);
  assertEquals(toolNames.includes("get_server_info"), true);
  assertEquals(toolNames.includes("get_buck2_targets"), true);
  assertEquals(toolNames.includes("get_buck2_target_providers"), true);

  // Test conversion to MCP format
  const mcpTools = convertToMcpTools(TOOLS);
  const sourceFetchTool = mcpTools.find(t => t.name === "source_fetch");
  assertEquals(sourceFetchTool?.description, "Fetch source code from a repository and return the local path. Supports 'github:owner/repo' format.");
});

// Test MCP resource definitions and conversion
Deno.test("MCP resource definitions", () => {
  // Test that we have the expected resources
  assertEquals(RESOURCES.length, 4);

  // Test conversion to MCP format
  const mcpResources = convertToMcpResources(RESOURCES);
  assertEquals(mcpResources.length, 4);

  // Check that each resource has required properties
  for (const resource of mcpResources) {
    assertEquals(typeof resource.uri, "string");
    assertEquals(typeof resource.name, "string");
    assertEquals(typeof resource.description, "string");
  }
});

// Test tool execution with validation
Deno.test("Tool execution - invalid tool", async () => {
  const result = await executeTool("nonexistent_tool", {});
  assertEquals(result.isError, true);
  assertEquals(result.content[0].text, "Error: Unknown tool: nonexistent_tool");
});

Deno.test("Tool execution - validation error", async () => {
  const result = await executeTool("source_fetch", { url: 123 });
  assertEquals(result.isError, true);
  const errorText = result.content[0].text as string;
  assertEquals(errorText.includes("Expected string"), true);
});

// Test resource-backed tools
Deno.test("Resource-backed tool - get_server_info", async () => {
  const result = await executeTool("get_server_info", {});
  assertEquals(result.isError, false);
  assertEquals(result.content[0].type, "text");
  const text = result.content[0].text as string;
  assertEquals(text.includes("Brainiac MCP Server"), true);
  assertEquals(text.includes("Status: Running"), true);
  assertEquals(text.includes("Deno Version:"), true);
});

Deno.test("Resource-backed tool - get_config", async () => {
  const result = await executeTool("get_config", {});
  assertEquals(result.isError, false);
  assertEquals(result.content[0].type, "text");
  const text = result.content[0].text as string;
  assertEquals(text.includes("Brainiac MCP Server"), true);
  assertEquals(text.includes("version"), true);
  assertEquals(text.includes("features"), true);
});

// User profile tool has been removed - test removed
// Edge case tests and performance tests for add/capitalize functions removed

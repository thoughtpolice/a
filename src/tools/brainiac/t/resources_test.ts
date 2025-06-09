// SPDX-FileCopyrightText: © 2024-2025 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

import { assertEquals, assertStringIncludes } from "jsr:@std/assert";
import {
  convertToMcpResources,
  executeResource,
  RESOURCES,
} from "../resources.ts";

Deno.test("convertToMcpResources converts all resources", () => {
  const mcpResources = convertToMcpResources(RESOURCES);

  assertEquals(mcpResources.length, RESOURCES.length);
  assertEquals(mcpResources.length, 4); // config, serverInfo, buck2Targets, buck2TargetProviders

  // Check that each resource has required properties
  for (const resource of mcpResources) {
    assertEquals(typeof resource.uri, "string");
    assertEquals(typeof resource.name, "string");
    assertEquals(typeof resource.description, "string");
  }
});

Deno.test("executeResource handles static config resource", async () => {
  const result = await executeResource("config://app");

  assertEquals(result.contents.length, 1);
  assertEquals(result.contents[0].uri, "config://app");
  assertEquals(result.contents[0].mimeType, "application/json");

  // Should contain valid JSON
  const config = JSON.parse(result.contents[0].text as string);
  assertEquals(config.name, "Brainiac MCP Server");
  assertEquals(config.version, "0.1.0");
});

Deno.test("executeResource handles static server info resource", async () => {
  const result = await executeResource("info://server");

  assertEquals(result.contents.length, 1);
  assertEquals(result.contents[0].uri, "info://server");
  assertEquals(result.contents[0].mimeType, "text/plain");

  assertStringIncludes(result.contents[0].text as string, "Brainiac MCP Server");
  assertStringIncludes(result.contents[0].text as string, "Status: Running");
});

// User profile resource has been removed - test removed

Deno.test("executeResource handles unknown resource", async () => {
  const result = await executeResource("unknown://resource");

  assertEquals(result.contents.length, 1);
  assertEquals(result.contents[0].uri, "unknown://resource");
  assertEquals(result.contents[0].mimeType, "text/plain");
  assertStringIncludes(
    result.contents[0].text as string,
    "Error: Unknown resource",
  );
});

Deno.test("executeResource handles buck2 targets resource", async () => {
  const result = await executeResource("buck2://targets///src/...");

  assertEquals(result.contents.length, 1);
  assertEquals(result.contents[0].uri, "buck2://targets///src/...");
  assertEquals(result.contents[0].mimeType, "application/json");

  // Should contain valid JSON with either targets or error
  const data = JSON.parse(result.contents[0].text as string);
  assertEquals(data.target_pattern, "//src/...");
  
  // Could be either a success with targets array or an error
  if (data.error) {
    assertEquals(typeof data.error, "string");
  } else {
    assertEquals(Array.isArray(data.targets), true);
    assertEquals(typeof data.count, "number");
  }
});

Deno.test("executeResource handles buck2 audit providers resource", async () => {
  const result = await executeResource("buck2://providers///src/hello:hello");

  assertEquals(result.contents.length, 1);
  assertEquals(result.contents[0].uri, "buck2://providers///src/hello:hello");
  assertEquals(result.contents[0].mimeType, "application/json");

  // Should contain valid JSON with either providers or error
  const data = JSON.parse(result.contents[0].text as string);
  assertEquals(data.target, "//src/hello:hello");
  
  // Could be either a success with providers array or an error
  if (data.error) {
    assertEquals(typeof data.error, "string");
  } else {
    assertEquals(Array.isArray(data.providers), true);
    assertEquals(typeof data.count, "number");
  }
});

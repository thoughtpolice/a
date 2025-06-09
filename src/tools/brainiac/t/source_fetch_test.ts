// SPDX-FileCopyrightText: © 2024-2025 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

import { assertEquals, assertStringIncludes } from "@std/assert";
import { sourceFetchTool } from "../tools/source_fetch.ts";

Deno.test("source_fetch tool - invalid URL format", async () => {
  const result = await sourceFetchTool.handler({ url: "invalid:format" });
  assertEquals(result.isError, true);
  assertStringIncludes(
    result.content[0].type === "text" ? result.content[0].text : "",
    "Only 'github:' URLs are currently supported"
  );
});

Deno.test("source_fetch tool - invalid GitHub format", async () => {
  const result = await sourceFetchTool.handler({ url: "github:invalid" });
  assertEquals(result.isError, true);
  assertStringIncludes(
    result.content[0].type === "text" ? result.content[0].text : "",
    "Invalid GitHub URL format"
  );
});

Deno.test("source_fetch tool - valid GitHub URL format", async () => {
  const testPath = "./work/clones/Hello-World.git";
  
  // Clean up any existing repository first
  try {
    await Deno.remove(testPath, { recursive: true });
  } catch {
    // Ignore if doesn't exist
  }
  
  // Small delay to ensure cleanup completed
  await new Promise(resolve => setTimeout(resolve, 50));
  
  // Use a small, well-known public repo for testing
  const result = await sourceFetchTool.handler({ url: "github:octocat/Hello-World" });
  
  // In CI environments, git cloning might fail due to network restrictions
  // So we check if it's either a success (isError undefined) or a git-related error
  if (result.isError) {
    // If it's an error, it should be a git cloning error, not a format error
    const errorText = result.content[0].type === "text" ? result.content[0].text : "";
    assertStringIncludes(errorText, "Error cloning repository");
  } else {
    // If successful, should return a relative path
    const path = result.content[0].type === "text" ? result.content[0].text : "";
    assertStringIncludes(path, "./work/clones/Hello-World.git");
  }
  
  // Clean up after test with delay
  await new Promise(resolve => setTimeout(resolve, 50));
  try {
    await Deno.remove(testPath, { recursive: true });
  } catch {
    // Ignore cleanup errors
  }
});
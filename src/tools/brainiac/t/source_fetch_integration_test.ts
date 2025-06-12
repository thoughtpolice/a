// SPDX-FileCopyrightText: © 2024-2025 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

import { assertEquals, assertStringIncludes } from "@std/assert";
import { executeTool } from "../tools.ts";

Deno.test("source_fetch tool integration test", async () => {
  const testPath = "./work/clones/Spoon-Knife.git";

  // Clean up any existing repository first
  try {
    await Deno.remove(testPath, { recursive: true });
  } catch {
    // Ignore if doesn't exist
  }

  // Small delay to ensure cleanup completed
  await new Promise((resolve) => setTimeout(resolve, 50));

  // Test with a different small public repository to avoid conflicts
  const result = await executeTool("source_fetch", {
    url: "github:octocat/Spoon-Knife",
  });

  // In CI environments, git cloning might fail due to network restrictions
  // So we check if it's either a success (isError undefined) or a git-related error
  if (result.isError) {
    // If it's an error, it should be a git cloning error, not a format error
    const errorText = result.content[0].type === "text"
      ? result.content[0].text
      : "";
    assertStringIncludes(errorText, "Error cloning repository");
  } else {
    // Should return a relative path containing the expected location
    const path = result.content[0].type === "text"
      ? result.content[0].text
      : "";
    assertStringIncludes(path, "./work/clones/Spoon-Knife.git");

    // The returned path should exist as a directory
    const stat = await Deno.stat(path);
    assertEquals(stat.isDirectory, true);

    // Clean up the cloned repository after the test
    await new Promise((resolve) => setTimeout(resolve, 50));
    await Deno.remove(path, { recursive: true });
    assertEquals(
      await Deno.stat(path).catch(() => null),
      null,
      "Repository should be removed after test",
    );
  }
});

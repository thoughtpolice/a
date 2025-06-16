// SPDX-FileCopyrightText: © 2024-2025 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

import { TOOLS } from "./tools.ts";

// Simple validation program that checks if settings.json contains all MCP tools
async function main() {
  if (Deno.args.length < 1) {
    console.error("Usage: validate_settings.ts <path-to-settings.json>");
    Deno.exit(1);
  }

  const settingsPath = Deno.args[0];

  try {
    // Read and parse the settings file
    const settingsContent = await Deno.readTextFile(settingsPath);
    const settings = JSON.parse(settingsContent);

    // Check basic structure
    if (!settings.permissions || !settings.permissions.allow) {
      console.error("ERROR: settings.json missing permissions.allow field");
      Deno.exit(1);
    }

    // Get only safe MCP tool names from brainiac
    const safeMcpToolNames = TOOLS
      .filter((tool) => tool.is_mcp_safe)
      .map((tool) => `mcp__brainiac__${tool.name}`);

    // Check that each safe tool is in the allow list
    const allowList = settings.permissions.allow as string[];
    const missingTools: string[] = [];

    for (const toolName of safeMcpToolNames) {
      if (!allowList.includes(toolName)) {
        missingTools.push(toolName);
      }
    }

    if (missingTools.length > 0) {
      console.error(
        `ERROR: Missing MCP tools in settings.json: ${missingTools.join(", ")}`,
      );
      Deno.exit(1);
    }

    // Check for extra tools that don't exist or aren't marked as safe
    const brainiacToolsInSettings = allowList.filter(
      (tool) => tool.startsWith("mcp__brainiac__"),
    );
    const extraTools = brainiacToolsInSettings.filter(
      (tool) => !safeMcpToolNames.includes(tool),
    );

    if (extraTools.length > 0) {
      console.error(
        `ERROR: Extra MCP tools in settings.json that don't exist or aren't marked as safe: ${
          extraTools.join(", ")
        }`,
      );
      Deno.exit(1);
    }

    console.log(
      "SUCCESS: All safe MCP tools are properly configured in settings.json",
    );
    Deno.exit(0);
  } catch (error) {
    console.error(`ERROR: Failed to validate settings.json: ${error}`);
    Deno.exit(1);
  }
}

// Run the validation
await main();

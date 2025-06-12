// SPDX-FileCopyrightText: © 2024-2025 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

import { z } from "zod";
import { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { ToolDefinition } from "./types.ts";
import { executeBuck2Command, validateBuckTarget } from "../buck2_utils.ts";

interface Buck2BuildArgs {
  targets: string[];
}

const buck2BuildSchema = z.object({
  targets: z.array(z.string()).min(1).describe(
    "List of Buck2 target patterns to build",
  ),
});

async function executeBuck2Build(targets: string[]): Promise<CallToolResult> {
  try {
    // Validate all targets first
    const validatedTargets: string[] = [];
    const invalidTargets: string[] = [];

    for (const target of targets) {
      const validated = validateBuckTarget(target);
      if (validated) {
        validatedTargets.push(validated);
      } else {
        invalidTargets.push(target);
      }
    }

    if (invalidTargets.length > 0) {
      return {
        content: [{
          type: "text",
          text: `Error: Invalid or unsafe Buck2 target format(s): ${
            invalidTargets.join(", ")
          }`,
        }],
        isError: true,
      };
    }

    // Build arguments: build command + all targets
    const args = ["build", ...validatedTargets];
    const { code, stdout, stderr } = await executeBuck2Command(args);

    if (code !== 0) {
      return {
        content: [{
          type: "text",
          text: `Buck2 build failed with code ${code}\n\nTargets: ${
            validatedTargets.join(" ")
          }\n\nStderr:\n${stderr}\n\nStdout:\n${stdout}`,
        }],
        isError: true,
      };
    }

    // Success - return build output
    return {
      content: [{
        type: "text",
        text: `Buck2 build succeeded for targets: ${
          validatedTargets.join(" ")
        }\n\nBuild output:\n${stdout}${stderr ? `\nStderr:\n${stderr}` : ""}`,
      }],
      isError: false,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      content: [{
        type: "text",
        text: `Failed to execute buck2 build: ${message}`,
      }],
      isError: true,
    };
  }
}

export const buck2BuildTool: ToolDefinition<Buck2BuildArgs> = {
  name: "buck2_build",
  description: "Build Buck2 targets using buck2 build command",
  schema: buck2BuildSchema,
  handler: async (args: Buck2BuildArgs): Promise<CallToolResult> => {
    return await executeBuck2Build(args.targets);
  },
};

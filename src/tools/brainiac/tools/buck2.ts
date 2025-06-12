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

//
// Target Determination (QuickTD) Tool
//

interface TargetDeterminationArgs {
  from: string;
  to: string;
  universe: string[];
}

const targetDeterminationSchema = z.object({
  from: z.string().describe(
    "Base revset to compare from (e.g., 'trunk()', '@--')",
  ),
  to: z.string().describe("Target revset to compare to (e.g., '@', '@-')"),
  universe: z.array(z.string()).min(1).describe(
    "List of Buck2 target patterns to analyze (e.g., ['root//...', 'third-party//...'])",
  ),
});

/**
 * Main target determination logic using the existing quicktd tool
 */
async function executeTargetDetermination(
  from: string,
  to: string,
  universe: string[],
): Promise<CallToolResult> {
  try {
    // Validate all universe targets first
    const validatedUniverse: string[] = [];
    const invalidTargets: string[] = [];

    for (const target of universe) {
      const validated = validateBuckTarget(target);
      if (validated) {
        validatedUniverse.push(validated);
      } else {
        invalidTargets.push(target);
      }
    }

    if (invalidTargets.length > 0) {
      return {
        content: [{
          type: "text",
          text: `Error: Invalid or unsafe Buck2 target format(s) in universe: ${
            invalidTargets.join(", ")
          }`,
        }],
        isError: true,
      };
    }

    // Use the existing quicktd tool via buck2 run
    const args = [
      "run",
      "root//buck/tools/quicktd",
      "--",
      from,
      to,
      ...validatedUniverse,
    ];
    const { code, stdout, stderr } = await executeBuck2Command(
      args,
      "brainiac-quicktd",
    );

    if (code !== 0) {
      return {
        content: [{
          type: "text",
          text:
            `QuickTD failed with code ${code}\n\nStderr:\n${stderr}\n\nStdout:\n${stdout}`,
        }],
        isError: true,
      };
    }

    // The quicktd tool outputs the path to a file containing the target list
    const targetsFilePath = stdout.trim();

    // Read the targets file
    let targetsContent: string;
    try {
      targetsContent = await Deno.readTextFile(targetsFilePath);
    } catch (error) {
      return {
        content: [{
          type: "text",
          text: `Failed to read targets file ${targetsFilePath}: ${error}`,
        }],
        isError: true,
      };
    }

    // Parse the targets (one per line)
    const targets = targetsContent
      .trim()
      .split("\n")
      .filter((line) => line.trim() !== "")
      .map((line) => line.trim());

    return {
      content: [{
        type: "text",
        text: JSON.stringify(
          {
            from,
            to,
            universe: validatedUniverse,
            targets,
            count: targets.length,
          },
          null,
          2,
        ),
      }],
      isError: false,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      content: [{
        type: "text",
        text: `Failed to determine targets: ${message}`,
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

export const targetDeterminationTool: ToolDefinition<TargetDeterminationArgs> =
  {
    name: "target_determination",
    description:
      "Determine which Buck2 targets need to be rebuilt based on changes between two revisions",
    schema: targetDeterminationSchema,
    handler: async (args: TargetDeterminationArgs): Promise<CallToolResult> => {
      return await executeTargetDetermination(
        args.from,
        args.to,
        args.universe,
      );
    },
  };

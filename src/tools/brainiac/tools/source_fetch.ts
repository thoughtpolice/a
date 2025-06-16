// SPDX-FileCopyrightText: © 2024-2025 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

import { z } from "zod";
import { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { ToolDefinition } from "./types.ts";
import { join } from "@std/path";

const SourceFetchSchema = z.object({
  url: z.string().describe(
    "Source URL in format 'github:owner/repo' or similar",
  ),
});

type SourceFetchArgs = z.infer<typeof SourceFetchSchema>;

async function sourceFetchHandler(
  args: SourceFetchArgs,
): Promise<CallToolResult> {
  const { url } = args;

  // Parse the URL format
  if (!url.startsWith("github:")) {
    return {
      content: [
        {
          type: "text",
          text: "Error: Only 'github:' URLs are currently supported",
        },
      ],
      isError: true,
    };
  }

  // Extract owner/repo from github:owner/repo format
  const githubPath = url.slice("github:".length);
  const pathParts = githubPath.split("/");

  if (pathParts.length !== 2 || !pathParts[0] || !pathParts[1]) {
    return {
      content: [
        {
          type: "text",
          text:
            "Error: Invalid GitHub URL format. Expected 'github:owner/repo'",
        },
      ],
      isError: true,
    };
  }

  const [owner, repo] = pathParts;

  // Determine the clone directory - find repository root dynamically
  let currentDir = Deno.cwd();
  let repoRoot: string | null = null;

  // Walk up directories to find the repository root (contains .buckconfig)
  while (currentDir !== "/" && currentDir !== ".") {
    try {
      await Deno.stat(join(currentDir, ".buckconfig"));
      repoRoot = currentDir;
      break;
    } catch {
      // .buckconfig not found, go up one level
      const parent = join(currentDir, "..");
      if (parent === currentDir) break; // reached root
      currentDir = parent;
    }
  }

  if (!repoRoot) {
    return {
      content: [
        {
          type: "text",
          text: "Error: Could not find repository root (no .buckconfig found)",
        },
      ],
      isError: true,
    };
  }

  const workDir = join(repoRoot, "work");
  const clonesDir = join(workDir, "clones");
  const repoDir = join(clonesDir, `${repo}.git`);
  const relativePath = `./work/clones/${repo}.git`;

  try {
    // Create clones directory if it doesn't exist
    await Deno.mkdir(clonesDir, { recursive: true });

    // Check if repo already exists
    try {
      const stat = await Deno.stat(repoDir);
      if (stat.isDirectory) {
        // Repository already exists, return the relative path
        return {
          content: [
            {
              type: "text",
              text: relativePath,
            },
          ],
        };
      }
    } catch {
      // Directory doesn't exist, proceed with cloning
    }

    // Clone the repository
    const gitUrl = `https://github.com/${owner}/${repo}.git`;
    const cloneCmd = new Deno.Command("git", {
      args: ["clone", gitUrl, repoDir],
      cwd: workDir,
    });

    const cloneResult = await cloneCmd.output();

    if (!cloneResult.success) {
      const stderr = new TextDecoder().decode(cloneResult.stderr);
      return {
        content: [
          {
            type: "text",
            text: `Error cloning repository: ${stderr}`,
          },
        ],
        isError: true,
      };
    }

    // Return the relative path to the cloned repository
    return {
      content: [
        {
          type: "text",
          text: relativePath,
        },
      ],
    };
  } catch (error) {
    return {
      content: [
        {
          type: "text",
          text: `Error: ${
            error instanceof Error ? error.message : String(error)
          }`,
        },
      ],
      isError: true,
    };
  }
}

export const sourceFetchTool: ToolDefinition<SourceFetchArgs> = {
  name: "source_fetch",
  description:
    "Fetch source code from a repository and return the local path. Supports 'github:owner/repo' format.",
  schema: SourceFetchSchema,
  handler: sourceFetchHandler,
  is_mcp_safe: true,
};

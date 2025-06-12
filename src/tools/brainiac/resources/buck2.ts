// SPDX-FileCopyrightText: © 2024-2025 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

import { ReadResourceResult } from "@modelcontextprotocol/sdk/types.js";
import { DynamicResourceDefinition } from "./types.ts";
import { validateBuckTarget } from "../buck2_utils.ts";

interface Buck2TargetParams {
  target: string;
}

// Create standardized error response
function createErrorResponse(
  uri: URL,
  error: string,
  target?: string,
  useTargetPattern = false,
): ReadResourceResult {
  const targetField = useTargetPattern ? "target_pattern" : "target";
  return {
    contents: [{
      uri: uri.toString(),
      mimeType: "application/json",
      text: JSON.stringify(
        { error, ...(target && { [targetField]: target }) },
        null,
        2,
      ),
    }],
  };
}

// Execute buck2 command and return results
async function executeBuck2Command(
  uri: URL,
  args: string[],
  target: string,
): Promise<ReadResourceResult> {
  let tempFile: string | null = null;

  try {
    // Create temporary file for at-file syntax
    tempFile = await Deno.makeTempFile({ suffix: ".txt" });

    // Use fixed isolation directory name for nested buck2 invocations
    const isolationDir = "brainiac";

    // Write each argument on a separate line
    const argsContent = args.join("\n");
    await Deno.writeTextFile(tempFile, argsContent);

    const command = new Deno.Command("buck2", {
      args: ["--isolation-dir", isolationDir, `@${tempFile}`],
      stdout: "piped",
      stderr: "piped",
    });

    const { code, stdout, stderr } = await command.output();

    if (code !== 0) {
      const errorMessage = new TextDecoder().decode(stderr);
      const isTargetsCommand = args[0] === "targets";
      // Don't delete temp file on failure for debugging
      console.error(
        `buck2 command failed, temp file preserved at: ${tempFile}`,
      );
      tempFile = null; // Prevent cleanup
      return createErrorResponse(
        uri,
        `buck2 ${args[0]} failed with code ${code}: ${errorMessage}`,
        target,
        isTargetsCommand,
      );
    }

    const output = new TextDecoder().decode(stdout);
    const lines = output.trim().split("\n").filter((line) => line.length > 0);

    const isTargetsCommand = args[0] === "targets";
    return {
      contents: [{
        uri: uri.toString(),
        mimeType: "application/json",
        text: JSON.stringify(
          {
            [isTargetsCommand ? "target_pattern" : "target"]: target,
            [isTargetsCommand ? "targets" : "providers"]: lines,
            count: lines.length,
          },
          null,
          2,
        ),
      }],
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const isTargetsCommand = args[0] === "targets";
    // Don't delete temp file on failure for debugging
    if (tempFile) {
      console.error(
        `buck2 command failed, temp file preserved at: ${tempFile}`,
      );
      tempFile = null; // Prevent cleanup
    }
    return createErrorResponse(
      uri,
      `Failed to execute buck2 ${args[0]}: ${message}`,
      target,
      isTargetsCommand,
    );
  } finally {
    // Clean up temp file only on success
    if (tempFile) {
      try {
        await Deno.remove(tempFile);
      } catch {
        // Ignore cleanup errors
      }
    }
  }
}

// Generic handler for Buck2 commands
function createBuck2Handler(
  commandArgs: (target: string) => string[],
  isTargetsCommand = false,
) {
  return async (
    uri: URL,
    params?: Buck2TargetParams,
  ): Promise<ReadResourceResult> => {
    if (!params) {
      return createErrorResponse(uri, "Missing target parameter");
    }

    const decodedTarget = decodeURIComponent(params.target);
    const validatedTarget = validateBuckTarget(decodedTarget);

    if (!validatedTarget) {
      return createErrorResponse(
        uri,
        "Invalid or unsafe Buck2 target format",
        decodedTarget,
        isTargetsCommand,
      );
    }

    return await executeBuck2Command(
      uri,
      commandArgs(validatedTarget),
      validatedTarget,
    );
  };
}

export const buck2TargetsResource: DynamicResourceDefinition<
  Buck2TargetParams
> = {
  name: "buck2_targets",
  description: "List Buck2 targets matching a pattern",
  uriTemplate: "buck2://targets/{target}",
  mimeType: "application/json",
  handler: createBuck2Handler((target) => ["targets", target], true),
};

export const buck2TargetProvidersResource: DynamicResourceDefinition<
  Buck2TargetParams
> = {
  name: "buck2_target_providers",
  description: "List Buck2 providers for a specific target",
  uriTemplate: "buck2://providers/{target}",
  mimeType: "application/json",
  handler: createBuck2Handler(
    (target) => ["audit", "providers", target],
    false,
  ),
};

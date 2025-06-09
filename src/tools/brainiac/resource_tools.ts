// SPDX-FileCopyrightText: © 2024-2025 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

import { z } from "zod";
import { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { ToolDefinition } from "./tools/types.ts";
import {
  isDynamicResource,
  isStaticResource,
  ResourceDefinition,
} from "./resources/types.ts";
import { executeResource, RESOURCES } from "./resources.ts";

// Convert resource name to tool name (kebab-case to snake_case)
function resourceNameToToolName(resourceName: string): string {
  return `get_${resourceName.replace(/-/g, "_")}`;
}

// Parse URI template to extract parameter names
function parseUriTemplateParams(uriTemplate: string): string[] {
  const params: string[] = [];
  const regex = /\{([^}]+)\}/g;
  let match;
  while ((match = regex.exec(uriTemplate)) !== null) {
    params.push(match[1]);
  }
  return params;
}

// Generate Zod schema for dynamic resource parameters
function generateDynamicResourceSchema(
  resource: ResourceDefinition,
): z.ZodSchema {
  if (!isDynamicResource(resource)) {
    // Static resources have no parameters
    return z.object({});
  }

  const paramNames = parseUriTemplateParams(resource.uriTemplate);
  const schemaFields: Record<string, z.ZodTypeAny> = {};

  for (const paramName of paramNames) {
    // For now, treat all parameters as required strings
    // In a more sophisticated implementation, we could infer types
    // from the resource definition or add metadata
    schemaFields[paramName] = z.string().describe(`${paramName} parameter`);
  }

  return z.object(schemaFields);
}

// Build URI from template and parameters
function buildUri(uriTemplate: string, params: Record<string, string>): string {
  let uri = uriTemplate;
  for (const [key, value] of Object.entries(params)) {
    uri = uri.replace(`{${key}}`, encodeURIComponent(value));
  }
  return uri;
}

// Generate tool definition from resource
function generateResourceTool(
  resource: ResourceDefinition,
  // deno-lint-ignore no-explicit-any
): ToolDefinition<any> {
  const toolName = resourceNameToToolName(resource.name);
  const schema = generateDynamicResourceSchema(resource);

  return {
    name: toolName,
    description: `Get ${resource.description}`,
    schema,
    handler: async (args: Record<string, string>): Promise<CallToolResult> => {
      try {
        let uri: string;

        if (isStaticResource(resource)) {
          uri = resource.uri;
        } else {
          uri = buildUri(resource.uriTemplate, args);
        }

        const result = await executeResource(uri);

        // Convert resource result to tool result
        if (result.contents.length === 0) {
          return {
            content: [{
              type: "text",
              text: "No content returned from resource",
            }],
            isError: false,
          };
        }

        // Return the first content item
        const content = result.contents[0];
        const textContent = typeof content.text === "string"
          ? content.text
          : "No text content available";
        return {
          content: [{
            type: "text",
            text: textContent,
          }],
          isError: false,
        };
      } catch (error) {
        const errorMessage = error instanceof Error
          ? error.message
          : String(error);
        return {
          content: [{
            type: "text",
            text: `Error accessing resource: ${errorMessage}`,
          }],
          isError: true,
        };
      }
    },
  };
}

// Export individual generated tools for manual registration if needed
export const RESOURCE_TOOLS = RESOURCES.map(generateResourceTool);

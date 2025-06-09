// SPDX-FileCopyrightText: © 2024-2025 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

import { z } from "zod";
import { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";

import { ToolDefinition } from "./tools/types.ts";
import { sourceFetchTool } from "./tools/source_fetch.ts";
import { RESOURCE_TOOLS } from "./resource_tools.ts";

// Registry of all available tools (manual tools + resource-backed tools)
// deno-lint-ignore no-explicit-any
export const TOOLS: ToolDefinition<any>[] = [
  sourceFetchTool,
  ...RESOURCE_TOOLS,
];

// Convert tool definitions to MCP Tool format
// deno-lint-ignore no-explicit-any
export function convertToMcpTools(tools: ToolDefinition<any>[]): Tool[] {
  return tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    inputSchema: zodSchemaToJsonSchema(tool.schema),
  }));
}

// Convert Zod schema to JSON Schema for MCP
function zodSchemaToJsonSchema(
  schema: z.ZodSchema,
): { type: "object"; properties: Record<string, unknown>; required: string[] } {
  // Basic conversion for ZodObject schemas
  // In a real implementation, you might want to use a library like zod-to-json-schema
  if (schema instanceof z.ZodObject) {
    const shape = schema.shape;
    const properties: Record<string, unknown> = {};
    const required: string[] = [];

    for (const [key, value] of Object.entries(shape)) {
      const zodField = value as z.ZodTypeAny;

      // Extract description from the schema if available
      let description = "";
      if (zodField._def && zodField._def.description) {
        description = zodField._def.description;
      }

      // Determine the type based on the Zod schema
      let type = "unknown";
      if (zodField instanceof z.ZodNumber) {
        type = "number";
      } else if (zodField instanceof z.ZodString) {
        type = "string";
      } else if (zodField instanceof z.ZodBoolean) {
        type = "boolean";
      }

      properties[key] = {
        type,
        description,
      };

      // Check if field is required (not optional)
      if (!zodField.isOptional()) {
        required.push(key);
      }
    }

    return {
      type: "object",
      properties,
      required,
    };
  }

  // Fallback for unknown schemas
  return {
    type: "object",
    properties: {},
    required: [],
  };
}

// Tool execution with validation
export async function executeTool(
  toolName: string,
  args: unknown,
): Promise<CallToolResult> {
  const tool = TOOLS.find((t) => t.name === toolName);
  if (!tool) {
    return {
      content: [
        {
          type: "text",
          text: `Error: Unknown tool: ${toolName}`,
        },
      ],
      isError: true,
    };
  }

  try {
    // Validate arguments using Zod
    const validatedArgs = tool.schema.parse(args);

    // Execute the tool handler
    const result = await tool.handler(validatedArgs);
    return result;
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    return {
      content: [
        {
          type: "text",
          text: `Error: ${errorMessage}`,
        },
      ],
      isError: true,
    };
  }
}

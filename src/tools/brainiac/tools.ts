// SPDX-FileCopyrightText: © 2024-2025 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

import { z } from "zod";
import { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";

import { ToolDefinition } from "./tools/types.ts";
import { sourceFetchTool } from "./tools/source_fetch.ts";
import { buck2BuildTool, buck2TestTool, targetDeterminationTool } from "./tools/buck2.ts";
import { RESOURCE_TOOLS } from "./resource_tools.ts";

// Registry of manual tools
// deno-lint-ignore no-explicit-any
const MANUAL_TOOLS: ToolDefinition<any>[] = [
  sourceFetchTool,
  buck2BuildTool,
  buck2TestTool,
  targetDeterminationTool,
];

// Get tools based on configuration
// deno-lint-ignore no-explicit-any
export function getTools(convertResourcesToTools: boolean): ToolDefinition<any>[] {
  if (convertResourcesToTools) {
    return [...MANUAL_TOOLS, ...RESOURCE_TOOLS];
  }
  return MANUAL_TOOLS;
}

// Legacy export for backward compatibility (uses all tools including resource tools)
// deno-lint-ignore no-explicit-any
export const TOOLS: ToolDefinition<any>[] = [...MANUAL_TOOLS, ...RESOURCE_TOOLS];

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
      const propertyDef: Record<string, unknown> = { description };

      if (zodField instanceof z.ZodNumber) {
        propertyDef.type = "number";
      } else if (zodField instanceof z.ZodString) {
        propertyDef.type = "string";
      } else if (zodField instanceof z.ZodBoolean) {
        propertyDef.type = "boolean";
      } else if (zodField instanceof z.ZodArray) {
        propertyDef.type = "array";
        // Get the inner type for array items
        const innerType = zodField._def.type;
        if (innerType instanceof z.ZodString) {
          propertyDef.items = { type: "string" };
        } else if (innerType instanceof z.ZodNumber) {
          propertyDef.items = { type: "number" };
        } else if (innerType instanceof z.ZodBoolean) {
          propertyDef.items = { type: "boolean" };
        } else {
          propertyDef.items = { type: "unknown" };
        }
      } else {
        propertyDef.type = "unknown";
      }

      properties[key] = propertyDef;

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
  // Use the global TOOLS array which includes all tools for execution
  // This ensures that even if resources aren't exposed as tools in the list,
  // they can still be executed if the client knows about them
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

// SPDX-FileCopyrightText: © 2024-2025 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

import { z } from "zod";
import { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

// Tool handler type definition
export type ToolHandler<T = unknown> = (
  args: T,
) => Promise<CallToolResult> | CallToolResult;

// Tool definition with Zod schema
export interface ToolDefinition<T = unknown> {
  name: string;
  description: string;
  schema: z.ZodSchema<T>;
  handler: ToolHandler<T>;
}

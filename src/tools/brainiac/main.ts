// SPDX-FileCopyrightText: © 2024-2025 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { convertToMcpTools, executeTool, TOOLS } from "./tools.ts";
import {
  convertToMcpResources,
  executeResource,
  RESOURCES,
} from "./resources.ts";

async function main() {
  const server = new Server(
    {
      name: "brainiac",
      version: "0.1.0",
    },
    {
      capabilities: {
        tools: {},
        resources: {},
      },
    },
  );

  server.setRequestHandler(
    ListToolsRequestSchema,
    () => ({ tools: convertToMcpTools(TOOLS) }),
  );

  // Handle tool calls
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    return await executeTool(name, args);
  });

  // Handle resource listing
  server.setRequestHandler(
    ListResourcesRequestSchema,
    () => ({ resources: convertToMcpResources(RESOURCES) }),
  );

  // Handle resource reading
  server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
    const { uri } = request.params;
    return await executeResource(uri);
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("Brainiac started");
}

if (import.meta.main) {
  main().catch((error) => {
    console.error("Server error:", error);
    Deno.exit(1);
  });
}

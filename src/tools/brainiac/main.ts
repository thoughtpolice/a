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
import { convertToMcpTools, executeTool, getTools } from "./tools.ts";
import {
  convertToMcpResources,
  executeResource,
  RESOURCES,
} from "./resources.ts";

// Parse command line arguments
function parseArgs(): { convertResourcesToTools: boolean } {
  const args = Deno.args;
  const convertResourcesToTools = args.includes("--convert-resources-to-tools");

  // Check for help flag
  if (args.includes("--help") || args.includes("-h")) {
    console.error("Brainiac MCP Server");
    console.error("");
    console.error("Usage: brainiac [options]");
    console.error("");
    console.error("Options:");
    console.error("  --convert-resources-to-tools  Convert resources to tools (default: false)");
    console.error("  --help, -h                    Show this help message");
    Deno.exit(0);
  }

  return { convertResourcesToTools };
}

// Configuration options
const config = parseArgs();

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
    () => ({ tools: convertToMcpTools(getTools(config.convertResourcesToTools)) }),
  );

  // Handle tool calls
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    return await executeTool(name, args);
  });

  // Handle resource listing - only expose if not converting to tools
  if (!config.convertResourcesToTools) {
    server.setRequestHandler(
      ListResourcesRequestSchema,
      () => ({ resources: convertToMcpResources(RESOURCES) }),
    );

    // Handle resource reading
    server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
      const { uri } = request.params;
      return await executeResource(uri);
    });
  } else {
    // If converting resources to tools, return empty resource list
    server.setRequestHandler(
      ListResourcesRequestSchema,
      () => ({ resources: [] }),
    );
  }

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

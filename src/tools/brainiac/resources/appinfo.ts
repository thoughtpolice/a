// SPDX-FileCopyrightText: © 2024-2025 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

import { StaticResourceDefinition } from "./types.ts";

// Example static resource - configuration
export const configResource: StaticResourceDefinition = {
  name: "config",
  description: "Application configuration and settings",
  uri: "config://app",
  mimeType: "application/json",
  is_mcp_safe: true,
  handler: (uri) => {
    const config = {
      name: "Brainiac MCP Server",
      version: "0.1.0",
      features: ["tools", "resources"],
      settings: {
        timeout: 30000,
        retries: 3,
      },
    };

    return {
      contents: [{
        uri: uri.href,
        mimeType: "application/json",
        text: JSON.stringify(config, null, 2),
      }],
    };
  },
};

// Example static resource - server info
export const serverInfoResource: StaticResourceDefinition = {
  name: "server-info",
  description: "Server runtime information and status",
  uri: "info://server",
  mimeType: "text/plain",
  is_mcp_safe: true,
  handler: (uri) => {
    const info = `Brainiac MCP Server
Status: Running
Uptime: ${Math.floor(performance.now() / 1000)}s
Deno Version: ${Deno.version.deno}
Timestamp: ${new Date().toISOString()}`;

    return {
      contents: [{
        uri: uri.href,
        mimeType: "text/plain",
        text: info,
      }],
    };
  },
};

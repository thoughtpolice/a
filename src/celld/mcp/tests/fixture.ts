// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * A demo server and request builders shared by the suites.
 *
 * @module
 */

import {
  type ClientCapabilities,
  type JSONRPCRequest,
  type JSONRPCResponse,
  LATEST_PROTOCOL_VERSION,
  McpError,
  mcpHeader,
  McpServer,
  type McpServerOptions,
  META,
  ToolError,
} from "@celld/mcp";
import { v } from "@celld/sieve";

export const SECRET = "test-secret-0123456789abcdef0123456789";
export const CLIENT_INFO = { name: "test-client", version: "1.0.0" };
export const SERVER_INFO = { name: "demo", version: "0.1.0" };

/** A valid request `_meta`, with overrides. */
export function meta(
  extra: Record<string, unknown> = {},
  capabilities: ClientCapabilities = {},
): Record<string, unknown> {
  return {
    [META.protocolVersion]: LATEST_PROTOCOL_VERSION,
    [META.clientCapabilities]: capabilities,
    [META.clientInfo]: CLIENT_INFO,
    ...extra,
  };
}

let nextId = 1;

/** A framed request with a valid `_meta`. */
export function request(
  method: string,
  params: Record<string, unknown> = {},
  options: {
    meta?: Record<string, unknown>;
    capabilities?: ClientCapabilities;
    id?: string | number;
  } = {},
): JSONRPCRequest {
  return {
    jsonrpc: "2.0",
    id: options.id ?? nextId++,
    method,
    params: { ...params, _meta: meta(options.meta, options.capabilities) },
  };
}

/** The result of a response, or a thrown description of its error. */
export function resultOf(
  response: JSONRPCResponse | null,
): Record<string, unknown> {
  if (response === null) throw new Error("no response");
  if ("error" in response) {
    throw new Error(`error ${response.error.code}: ${response.error.message}`);
  }
  return response.result as Record<string, unknown>;
}

/** The error of a response. */
export function errorOf(
  response: JSONRPCResponse | null,
): { code: number; message: string; data?: unknown } {
  if (response === null || !("error" in response)) {
    throw new Error(`expected an error, got ${JSON.stringify(response)}`);
  }
  return response.error;
}

/** A server with one of everything. */
export function demoServer(options: Partial<McpServerOptions> = {}): McpServer {
  const server = new McpServer({
    info: SERVER_INFO,
    instructions: "Test server.",
    stateSecret: SECRET,
    ...options,
  });
  server.tool({
    name: "echo",
    description: "Echoes its text.",
    input: v.strictObject({ text: v.string() }),
    run: ({ text }) => text,
  });
  server.tool({
    name: "add",
    input: v.strictObject({ a: v.int(), b: v.int() }),
    output: v.strictObject({ sum: v.int() }),
    run: ({ a, b }) => ({ structuredContent: { sum: a + b } }),
  });
  server.tool({
    name: "query",
    input: v.strictObject({
      region: mcpHeader(v.string(), "Region"),
      limit: mcpHeader(v.int(), "Limit").optional(),
      dry: mcpHeader(v.boolean(), "Dry").optional(),
      sql: v.string(),
    }),
    run: ({ region, sql }) => `${region}: ${sql}`,
  });
  server.tool({
    name: "fail",
    input: v.strictObject({ how: v.enum(["tool", "crash", "rpc"]) }),
    run: ({ how }) => {
      if (how === "tool") throw new ToolError("the tool failed on purpose");
      if (how === "crash") throw new Error("secret internal detail");
      throw McpError.invalidParams("rpc failure on purpose");
    },
  });
  server.tool({
    name: "login",
    description: "Asks for a GitHub login, then greets it.",
    run: (_args, ctx) => {
      const answer = ctx.elicit("github", {
        mode: "form",
        message: "Your GitHub login?",
        requestedSchema: {
          type: "object",
          properties: { login: { type: "string" } },
          required: ["login"],
        },
      });
      if (answer.action !== "accept") return "no login";
      return `hello ${answer.content?.login}`;
    },
  });
  server.prompt({
    name: "greet",
    description: "Greets someone.",
    arguments: [{ name: "name", required: true }, { name: "tone" }],
    complete: {
      name: (value) =>
        ["alice", "albert", "bob"].filter((n) => n.startsWith(value)),
    },
    get: ({ name, tone }) => [{
      role: "user",
      content: {
        type: "text",
        text: `Greet ${name}${tone ? ` ${tone}ly` : ""}.`,
      },
    }],
  });
  server.resource({
    uri: "config://app",
    name: "config",
    mimeType: "application/json",
    cache: { ttlMs: 5000, scope: "public" },
    read: () => '{"debug":true}',
  });
  server.resourceTemplate({
    uriTemplate: "file:///{+path}",
    name: "files",
    complete: {
      path: (value) => ["a.txt", "b.txt"].filter((p) => p.startsWith(value)),
    },
    read: (uri, { path }) =>
      path === "missing.txt"
        ? null
        : path.endsWith(".bin")
        ? new Uint8Array([0, 1, 2, 255])
        : [{ uri, mimeType: "text/plain", text: `contents of ${path}` }],
  });
  return server;
}

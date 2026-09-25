// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * `@celld/mcp`: a client and a server for the Model Context Protocol,
 * revision 2026-07-28 (stateless: per-request `_meta`, `server/discover`,
 * multi round-trip requests, `subscriptions/listen`), for celld Workers.
 *
 * This entry point has no `cloudflare:*` imports, so it loads in plain Deno.
 * The subpaths add the rest:
 *
 * - `@celld/mcp/durable`: the `McpChangeHub` Durable Object behind
 *   `durableChangeSource`, and `McpTaskObject` behind `durableTaskStore`.
 * - `@celld/mcp/testing`: an in-process transport and a `fetch` that calls
 *   an HTTP handler directly.
 *
 * Tool schemas are `@celld/sieve` schemas (or raw JSON Schema), the HTTP
 * endpoint is a `@celld/router` route (`mcpRoutes`, or `mcpHttpHandler`
 * for a Worker that serves nothing else), and OAuth is `@celld/oauth`: a
 * `ResourceServer` behind the endpoint, and an `OAuthSession` as the
 * client transport's `HttpAuthProvider`.
 *
 * @module
 */

export * from "./cache.ts";
export * from "./client.ts";
export * from "./errors.ts";
export * from "./headers.ts";
export * from "./http.ts";
export * from "./hub.ts";
export * from "./json.ts";
export * from "./jsonschema.ts";
export * from "./meta.ts";
export * from "./mrtr.ts";
export * from "./server.ts";
export * from "./state.ts";
export * from "./subscriptions.ts";
export * from "./task_store.ts";
export * from "./tasks.ts";
export * from "./transport.ts";
export * from "./types.ts";
export * from "./validate.ts";

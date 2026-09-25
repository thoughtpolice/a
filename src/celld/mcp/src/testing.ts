// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * `@celld/mcp/testing`: connect a client to a server without sockets.
 *
 * - {@link inProcessTransport} hands requests straight to
 *   `McpServer.handle`: no HTTP, no headers, just the protocol. Messages are
 *   copied through JSON both ways, so a value that would not survive the
 *   wire does not survive here either.
 * - {@link handlerFetch} is a `fetch` that calls a Streamable HTTP handler
 *   directly, so a client over `httpTransport` exercises every header,
 *   status and SSE rule of the real transport in process.
 * - {@link testPrincipal} builds the `@celld/router` principal a route's
 *   auth scheme would, for requests handed to the server directly.
 *
 * ```ts
 * const client = new McpClient({ transport: inProcessTransport(server), info });
 * const http = McpClient.http("http://mcp.test/mcp", {
 *   info,
 *   fetch: handlerFetch(mcpHttpHandler(server)),
 * });
 * ```
 *
 * @module
 */

import { toPrincipal } from "@celld/router";
import { McpError } from "./errors.ts";
import type { McpServer, Principal } from "./server.ts";
import type { FetchLike, Transport } from "./transport.ts";
import type { JSONRPCRequest } from "./types.ts";

/** Options for {@link inProcessTransport}. */
export interface InProcessOptions {
  /** The principal every request runs as; default none. */
  readonly principal?: Principal | null;
}

/** A transport that dispatches to `server` in the same isolate. */
export function inProcessTransport(
  server: McpServer,
  options: InProcessOptions = {},
): Transport {
  return {
    async request(message, { signal, onNotification }) {
      const copy = JSON.parse(JSON.stringify(message)) as JSONRPCRequest;
      const response = await server.handle(copy, {
        signal,
        principal: options.principal ?? null,
        emit: (notification) =>
          onNotification(JSON.parse(JSON.stringify(notification))),
      });
      if (response === null) {
        throw new McpError("aborted", "the request was aborted");
      }
      return JSON.parse(JSON.stringify(response));
    },
  };
}

/**
 * A `fetch` that calls `handler` instead of the network. The request gets
 * its own AbortSignal wired to the caller's, as a server sees a client
 * disconnect.
 */
export function handlerFetch(
  handler: (request: Request) => Promise<Response>,
): FetchLike {
  return async (input, init) => {
    const request = new Request(input, init);
    if (init?.signal?.aborted) throw init.signal.reason;
    return await handler(request);
  };
}

/** Options for {@link testPrincipal}. */
export interface TestPrincipalOptions {
  readonly scopes?: readonly string[];
  readonly roles?: readonly string[];
  readonly claims?: Readonly<Record<string, unknown>>;
  /** Default `test`. */
  readonly scheme?: string;
}

/** A frozen principal, as the router makes one from a scheme's answer. */
export function testPrincipal(
  subject: string,
  options: TestPrincipalOptions = {},
): Principal {
  const { scheme = "test", ...rest } = options;
  return toPrincipal({ subject, ...rest }, scheme);
}

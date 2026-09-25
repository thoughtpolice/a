// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

import { assert, assertEquals } from "@celld/assert";
import {
  McpClient,
  McpError,
  mcpHttpHandler,
  McpServer,
  MemoryChangeSource,
  META,
} from "@celld/mcp";
import { handlerFetch, inProcessTransport } from "@celld/mcp/testing";
import { CLIENT_INFO, request, SERVER_INFO } from "./fixture.ts";

/** A server whose `wait` tool runs until its signal fires, and records it. */
function waiter() {
  const server = new McpServer({ info: SERVER_INFO });
  const state = { started: 0, cancelled: 0 };
  let started: () => void = () => {};
  const running = new Promise<void>((resolve) => {
    started = resolve;
  });
  server.tool({
    name: "wait",
    run: (_args, ctx) =>
      new Promise((_resolve, reject) => {
        state.started++;
        ctx.progress(1);
        started();
        ctx.signal.addEventListener("abort", () => {
          state.cancelled++;
          reject(ctx.signal.reason);
        });
      }),
  });
  return { server, state, running };
}

async function kindOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    assert(error instanceof McpError, `not an McpError: ${error}`);
    return error.kind;
  }
  return "resolved";
}

Deno.test("an aborted execute resolves to null and signals the handler", async () => {
  const { server, state, running } = waiter();
  const stop = new AbortController();
  const done = server.handle(request("tools/call", { name: "wait" }), {
    signal: stop.signal,
  });
  await running;
  stop.abort();
  assertEquals(await done, null);
  assertEquals(state, { started: 1, cancelled: 1 });
});

Deno.test("the client's signal cancels an in-process call", async () => {
  const { server, state, running } = waiter();
  const client = new McpClient({
    transport: inProcessTransport(server),
    info: CLIENT_INFO,
  });
  const stop = new AbortController();
  const call = client.callTool("wait", {}, { signal: stop.signal });
  await running;
  stop.abort();
  assertEquals(await kindOf(call), "aborted");
  assertEquals(state.cancelled, 1);
  // Already aborted: nothing is sent.
  assertEquals(
    await kindOf(client.callTool("wait", {}, { signal: AbortSignal.abort() })),
    "aborted",
  );
  assertEquals(state.started, 1);
});

Deno.test("closing an SSE response cancels the request on the server", async () => {
  const { server, state, running } = waiter();
  const handler = mcpHttpHandler(server);
  const message = request("tools/call", { name: "wait" }, {
    meta: { [META.progressToken]: "t" },
  });
  const response = await handler(
    new Request("https://mcp.test/", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "mcp-protocol-version": "2026-07-28",
        "mcp-method": "tools/call",
        "mcp-name": "wait",
      },
      body: JSON.stringify(message),
    }),
  );
  await running;
  assertEquals(response.headers.get("content-type"), "text/event-stream");
  await response.body!.cancel();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assertEquals(state.cancelled, 1);
});

Deno.test("a client over HTTP cancels by closing the stream, and times out", async () => {
  const { server, state, running } = waiter();
  const client = McpClient.http("https://mcp.test/", {
    info: CLIENT_INFO,
    fetch: handlerFetch(mcpHttpHandler(server)),
  });
  const stop = new AbortController();
  const call = client.callTool("wait", {}, {
    signal: stop.signal,
    onProgress: () => {},
  });
  await running;
  stop.abort();
  assertEquals(await kindOf(call), "aborted");
  await new Promise((resolve) => setTimeout(resolve, 0));
  assertEquals(state.cancelled, 1);
  assertEquals(
    await kindOf(
      client.callTool("wait", {}, { timeoutMs: 20, onProgress: () => {} }),
    ),
    "timeout",
  );
  await new Promise((resolve) => setTimeout(resolve, 0));
  assertEquals(state.cancelled, 2);
});

Deno.test("closing a subscription ends it on the server", async () => {
  const changes = new MemoryChangeSource();
  const server = new McpServer({ info: SERVER_INFO, changes });
  server.tool({ name: "t", run: () => "" });
  const client = new McpClient({
    info: CLIENT_INFO,
    transport: inProcessTransport(server),
  });
  const subscription = client.listen({ toolsListChanged: true });
  await subscription.acknowledged;
  assertEquals(changes.listeners, 1);
  subscription.close();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assertEquals(changes.listeners, 0);
  const received = [];
  for await (const notification of subscription) received.push(notification);
  assertEquals(received, []);
  assert(!subscription.endedGracefully, "closed by the client");
});

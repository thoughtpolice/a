// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

import { assertEquals } from "@celld/assert";
import {
  type JSONRPCNotification,
  type LoggingMessageNotificationParams,
  McpClient,
  mcpHttpHandler,
  McpServer,
  type McpServerOptions,
  META,
  type ProgressNotificationParams,
} from "@celld/mcp";
import { handlerFetch, inProcessTransport } from "@celld/mcp/testing";
import {
  CLIENT_INFO,
  errorOf,
  request,
  resultOf,
  SERVER_INFO,
} from "./fixture.ts";

function chatty(options: Partial<McpServerOptions> = {}) {
  const server = new McpServer({ info: SERVER_INFO, ...options });
  let late: (() => void) | null = null;
  server.tool({
    name: "chatty",
    run: async (_args, ctx) => {
      ctx.progress(0.5, { total: 1 });
      ctx.progress(0.5); // Not an increase: dropped.
      ctx.progress(0.25); // A decrease: dropped.
      ctx.log("debug", "fine detail");
      ctx.log("warning", { note: "careful" }, "db");
      await new Promise((resolve) => setTimeout(resolve, 2));
      ctx.progress(1, { total: 1, message: "done" });
      late = () => {
        ctx.progress(2);
        ctx.log("error", "after the end");
      };
      return "ok";
    },
  });
  return { server, fireLate: () => late?.() };
}

async function run(
  server: McpServer,
  meta: Record<string, unknown>,
): Promise<JSONRPCNotification[]> {
  const seen: JSONRPCNotification[] = [];
  resultOf(
    await server.handle(request("tools/call", { name: "chatty" }, { meta }), {
      emit: (n) => void seen.push(n),
    }),
  );
  return seen;
}

Deno.test("nothing is sent unless the request asked", async () => {
  const { server } = chatty({ logging: true });
  assertEquals(await run(server, {}), []);
});

Deno.test("progress follows the token and only increases", async () => {
  const { server, fireLate } = chatty();
  const seen = await run(server, { [META.progressToken]: 7 });
  assertEquals(seen, [
    {
      jsonrpc: "2.0",
      method: "notifications/progress",
      params: { progressToken: 7, progress: 0.5, total: 1 },
    },
    {
      jsonrpc: "2.0",
      method: "notifications/progress",
      params: { progressToken: 7, progress: 1, total: 1, message: "done" },
    },
  ]);
  // Nothing after the handler returned.
  fireLate();
  assertEquals(seen.length, 2);
});

Deno.test("log messages need logging enabled and the requested level", async () => {
  const quiet = chatty().server;
  assertEquals(await run(quiet, { [META.logLevel]: "debug" }), []);
  const { server } = chatty({ logging: true });
  const all = await run(server, { [META.logLevel]: "debug" });
  assertEquals(all.map((n) => n.params), [
    { level: "debug", data: "fine detail" },
    { level: "warning", data: { note: "careful" }, logger: "db" },
  ]);
  const some = await run(server, { [META.logLevel]: "warning" });
  assertEquals(some.map((n) => n.params?.level), ["warning"]);
  const discovered = resultOf(await server.handle(request("server/discover")));
  assertEquals(
    (discovered.capabilities as Record<string, unknown>).logging,
    {},
  );
  // An unknown level is invalid params.
  assertEquals(
    errorOf(
      await server.handle(
        request("tools/call", { name: "chatty" }, {
          meta: { [META.logLevel]: "loud" },
        }),
      ),
    ).code,
    -32602,
  );
});

Deno.test("the client routes progress and logs, in process and over SSE", async () => {
  const { server } = chatty({ logging: true });
  const transports = [
    inProcessTransport(server),
    McpClient.http("https://mcp.test/mcp", {
      info: CLIENT_INFO,
      fetch: handlerFetch(mcpHttpHandler(server)),
    }),
  ];
  for (const target of transports) {
    const client = target instanceof McpClient
      ? target
      : new McpClient({ transport: target, info: CLIENT_INFO });
    const progress: ProgressNotificationParams[] = [];
    const logs: LoggingMessageNotificationParams[] = [];
    const result = await client.callTool("chatty", {}, {
      onProgress: (p) => progress.push(p),
      logLevel: "warning",
      onLog: (l) => logs.push(l),
    });
    assertEquals(result.content, [{ type: "text", text: "ok" }]);
    assertEquals(progress.map((p) => [p.progress, p.message]), [
      [0.5, undefined],
      [1, "done"],
    ]);
    assertEquals(logs.map((l) => l.logger), ["db"]);
  }
});

Deno.test("progress resets the client's timeout", async () => {
  const server = new McpServer({ info: SERVER_INFO });
  server.tool({
    name: "slow",
    run: async (_args, ctx) => {
      for (let step = 1; step <= 4; step++) {
        await new Promise((resolve) => setTimeout(resolve, 25));
        ctx.progress(step);
      }
      return "done";
    },
  });
  const client = new McpClient({
    transport: inProcessTransport(server),
    info: CLIENT_INFO,
    timeoutMs: 60,
  });
  // 100 ms of work, but never 60 ms without progress.
  const result = await client.callTool("slow", {}, { onProgress: () => {} });
  assertEquals(result.content, [{ type: "text", text: "done" }]);
  let kind = "";
  try {
    await client.callTool("slow", {}, { timeoutMs: 30 });
  } catch (error) {
    kind = (error as { kind: string }).kind;
  }
  assertEquals(kind, "timeout");
});

// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * The tasks extension, client side: capability declaration, detecting a
 * task, polling with the server's interval, input through `tasks/update`,
 * cancellation, failures, the handle API, `Mcp-Name` routing on Streamable
 * HTTP, and notifications instead of polling.
 */

import { assert, assertEquals } from "@celld/assert";
import {
  type DetailedTask,
  type FetchLike,
  type JSONRPCRequest,
  type JSONRPCResponse,
  McpClient,
  McpError,
  mcpHttpHandler,
  McpServer,
  MemoryChangeSource,
  MemoryTaskStore,
  META,
  TaskHandle,
  TASKS_EXTENSION,
  type Transport,
} from "@celld/mcp";
import { v } from "@celld/sieve";
import { handlerFetch, inProcessTransport } from "@celld/mcp/testing";
import { CLIENT_INFO, SERVER_INFO } from "./fixture.ts";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function failure(promise: Promise<unknown>): Promise<McpError> {
  try {
    await promise;
  } catch (error) {
    assert(error instanceof McpError, `not an McpError: ${error}`);
    return error;
  }
  throw new Error("resolved");
}

function server(
  options: { pollIntervalMs?: number; changes?: MemoryChangeSource } = {},
) {
  const release = { value: false };
  const server = new McpServer({
    info: SERVER_INFO,
    changes: options.changes,
    tasks: {
      store: new MemoryTaskStore(),
      pollIntervalMs: options.pollIntervalMs ?? 10,
    },
  });
  server.tool({
    name: "sum",
    input: v.strictObject({ a: v.int(), b: v.int() }),
    output: v.strictObject({ sum: v.int() }),
    task: {
      run: async ({ a, b }, ctx) => {
        await ctx.status("adding");
        await sleep(20);
        return { structuredContent: { sum: a + b } };
      },
    },
  });
  server.tool({
    name: "greet",
    task: {
      run: (_args, ctx) => {
        const answer = ctx.elicit("name", {
          mode: "form",
          message: "Your name?",
          requestedSchema: {
            type: "object",
            properties: { name: { type: "string" } },
            required: ["name"],
          },
        });
        return `hello ${answer.content?.name}`;
      },
    },
  });
  server.tool({
    name: "wait",
    task: {
      run: async (_args, ctx) => {
        while (!release.value && !ctx.signal.aborted) await sleep(5);
        return "released";
      },
    },
  });
  server.tool({
    name: "broken",
    task: { run: () => Promise.reject(McpError.invalidParams("nope")) },
  });
  return { server, release };
}

Deno.test("the client declares the extension only when asked", async () => {
  const seen: unknown[] = [];
  const transport: Transport = {
    request(message) {
      seen.push(
        (message.params?._meta as Record<string, unknown>)[
          META.clientCapabilities
        ],
      );
      return Promise.resolve({
        jsonrpc: "2.0",
        id: message.id,
        result: { resultType: "complete", content: [] },
      });
    },
  };
  await new McpClient({ transport, info: CLIENT_INFO }).callTool("x");
  await new McpClient({ transport, info: CLIENT_INFO, tasks: true })
    .callTool("x");
  assertEquals(seen, [{}, { extensions: { [TASKS_EXTENSION]: {} } }]);
});

Deno.test("callTool follows a task to its result over HTTP", async () => {
  const { server: mcp } = server();
  const sent: {
    method: string | null;
    name: string | null;
    body: JSONRPCRequest;
  }[] = [];
  const fetch: FetchLike = (input, init) => {
    const headers = new Headers(init?.headers);
    sent.push({
      method: headers.get("mcp-method"),
      name: headers.get("mcp-name"),
      body: JSON.parse(String(init?.body)),
    });
    return handlerFetch(mcpHttpHandler(mcp))(input, init);
  };
  const statuses: string[] = [];
  let handle: TaskHandle | null = null;
  const client = McpClient.http("https://mcp.test/mcp", {
    info: CLIENT_INFO,
    fetch,
    tasks: { initialPollMs: 5 },
  });
  await client.listTools();
  const result = await client.callTool("sum", { a: 20, b: 22 }, {
    onTask: (task) => {
      handle = task;
    },
    onTaskStatus: (task) => statuses.push(task.status),
  });
  assertEquals(result.structuredContent, { sum: 42 });
  assert(handle !== null, "onTask ran");
  const taskId = (handle as TaskHandle).taskId;
  const polls = sent.filter((entry) => entry.method === "tasks/get");
  assert(polls.length >= 1, "polled");
  // Every task request is routed by its task id.
  for (const poll of polls) {
    assertEquals(poll.name, taskId);
    assertEquals(poll.body.params?.taskId, taskId);
  }
  assertEquals(statuses[statuses.length - 1], "completed");
});

Deno.test("task input is answered once through the handlers", async () => {
  const { server: mcp } = server();
  const asked: { key: string; taskId?: string; name: string }[] = [];
  const client = new McpClient({
    transport: inProcessTransport(mcp),
    info: CLIENT_INFO,
    tasks: { initialPollMs: 5 },
    handlers: {
      elicitation: (_params, context) => {
        asked.push({
          key: context.key,
          taskId: context.taskId,
          name: context.name,
        });
        return { action: "accept", content: { name: "grace" } };
      },
    },
  });
  const result = await client.callTool("greet");
  assertEquals(result.content, [{ type: "text", text: "hello grace" }]);
  assertEquals(asked.length, 1);
  assertEquals(asked[0].key, "name");
  assertEquals(asked[0].name, "greet");
  assert(typeof asked[0].taskId === "string", "the task id is passed");
});

Deno.test("a client without the extension gets -32021 for a task-only tool", async () => {
  const { server: mcp } = server();
  const client = new McpClient({
    transport: inProcessTransport(mcp),
    info: CLIENT_INFO,
  });
  const error = await failure(client.callTool("sum", { a: 1, b: 2 }));
  assertEquals(error.code, -32021);
});

Deno.test("a failed task throws its JSON-RPC error", async () => {
  const { server: mcp } = server();
  const client = new McpClient({
    transport: inProcessTransport(mcp),
    info: CLIENT_INFO,
    tasks: { initialPollMs: 5 },
  });
  const error = await failure(client.callTool("broken"));
  assertEquals([error.kind, error.code, error.message], [
    "rpc",
    -32602,
    "nope",
  ]);
});

Deno.test("startToolCall returns a handle to poll and cancel", async () => {
  const { server: mcp } = server();
  const client = new McpClient({
    transport: inProcessTransport(mcp),
    info: CLIENT_INFO,
    tasks: { initialPollMs: 5 },
  });
  const started = await client.startToolCall("wait");
  assertEquals(started.type, "task");
  const task = (started as { task: TaskHandle }).task;
  assertEquals(task.name, "wait");
  assertEquals(task.last.status, "working");
  assertEquals((await task.get()).status, "working");
  await task.cancel();
  const error = await failure(task.result());
  assertEquals(error.kind, "task_cancelled");
  assertEquals(error.message, "The client cancelled the task");
  assertEquals((await task.tryResult()).ok, false);
  // A synchronous tool still comes back complete.
  const plain = new McpServer({ info: SERVER_INFO });
  plain.tool({ name: "now", run: () => "done" });
  const direct = await new McpClient({
    transport: inProcessTransport(plain),
    info: CLIENT_INFO,
    tasks: true,
  }).startToolCall("now");
  assertEquals(direct.type, "complete");
});

Deno.test("a persisted task id can be resumed", async () => {
  const { server: mcp, release } = server();
  const client = new McpClient({
    transport: inProcessTransport(mcp),
    info: CLIENT_INFO,
    tasks: { initialPollMs: 5 },
  });
  const started = await client.startToolCall("wait");
  const taskId = (started as { task: TaskHandle }).task.taskId;
  const resumed = new McpClient({
    transport: inProcessTransport(mcp),
    info: CLIENT_INFO,
    tasks: { initialPollMs: 5 },
  }).task(taskId, "wait");
  release.value = true;
  const result = await resumed.result();
  assertEquals(result.content, [{ type: "text", text: "released" }]);
});

Deno.test("aborting callTool cancels its task", async () => {
  const { server: mcp } = server();
  const client = new McpClient({
    transport: inProcessTransport(mcp),
    info: CLIENT_INFO,
    tasks: { initialPollMs: 5 },
  });
  let handle: TaskHandle | null = null;
  const controller = new AbortController();
  const call = client.callTool("wait", {}, {
    signal: controller.signal,
    onTask: (task) => {
      handle = task;
    },
  });
  await sleep(30);
  controller.abort();
  assertEquals((await failure(call)).kind, "aborted");
  await sleep(20);
  assertEquals(
    (await (handle as unknown as TaskHandle).get()).status,
    "cancelled",
  );
});

Deno.test("polling honours the server's interval", async () => {
  const { server: mcp, release } = server({ pollIntervalMs: 60 });
  const times: number[] = [];
  const base = inProcessTransport(mcp);
  const transport: Transport = {
    request(message, options) {
      if (message.method === "tasks/get") times.push(performance.now());
      return base.request(message, options);
    },
  };
  const client = new McpClient({
    transport,
    info: CLIENT_INFO,
    tasks: { initialPollMs: 1, maxPollMs: 100 },
  });
  const started = await client.startToolCall("wait");
  setTimeout(() => {
    release.value = true;
  }, 400);
  await (started as { task: TaskHandle }).task.result();
  assert(times.length >= 2, `polled ${times.length} times`);
  for (let i = 1; i < times.length; i++) {
    assert(
      times[i] - times[i - 1] >= 55,
      `poll gap ${times[i] - times[i - 1]}`,
    );
  }
  // Backoff while nothing changes keeps the count down (at most ~400/60).
  assert(times.length <= 8, `polled ${times.length} times`);
});

Deno.test("notifications deliver the result without waiting for a poll", async () => {
  const changes = new MemoryChangeSource();
  const { server: mcp, release } = server({ pollIntervalMs: 5000, changes });
  const client = new McpClient({
    transport: inProcessTransport(mcp),
    info: CLIENT_INFO,
    tasks: { notifications: true },
  });
  const started = await client.startToolCall("wait");
  const task = (started as { task: TaskHandle }).task;
  const seen: DetailedTask[] = [];
  const began = performance.now();
  const waiting = task.result({ onStatus: (t) => seen.push(t) });
  await sleep(50);
  release.value = true;
  const result = await waiting;
  assertEquals(result.content, [{ type: "text", text: "released" }]);
  assert(performance.now() - began < 2000, "did not wait for the 5 s poll");
  assertEquals(seen[seen.length - 1].status, "completed");
  assertEquals(changes.listeners, 0);
});

/** A transport answering from a script. */
function scripted(
  answer: (message: JSONRPCRequest) => Record<string, unknown>,
): Transport {
  return {
    request(message) {
      return Promise.resolve(
        {
          jsonrpc: "2.0",
          id: message.id,
          ...answer(message),
        } as JSONRPCResponse,
      );
    },
  };
}

const TASK = {
  resultType: "task",
  taskId: "t1",
  status: "working",
  createdAt: "2026-09-25T00:00:00.000Z",
  lastUpdatedAt: "2026-09-25T00:00:00.000Z",
  ttlMs: null,
  pollIntervalMs: 1,
};

Deno.test("task results are refused where the extension does not allow them", async () => {
  const always = scripted(() => ({ result: TASK }));
  const withTasks = new McpClient({
    transport: always,
    info: CLIENT_INFO,
    tasks: true,
  });
  const read = await failure(withTasks.readResource("x://y"));
  assertEquals(read.kind, "decode");
  assert(read.message.includes("only tools/call"), read.message);
  const undeclared = await failure(
    new McpClient({ transport: always, info: CLIENT_INFO }).callTool("x"),
  );
  assertEquals(undeclared.kind, "decode");
  assert(undeclared.message.includes("did not declare"), undeclared.message);
  const malformed = await failure(
    new McpClient({
      transport: scripted(() => ({ result: { ...TASK, taskId: 7 } })),
      info: CLIENT_INFO,
      tasks: true,
    }).callTool("x"),
  );
  assertEquals(malformed.kind, "decode");
});

Deno.test("tasks/get answers are checked, and 'task' is read as complete", async () => {
  let polls = 0;
  const client = new McpClient({
    transport: scripted((message) => {
      if (message.method === "tools/call") return { result: TASK };
      polls++;
      if (polls === 1) {
        // One of the extension's examples marks tasks/get with "task".
        return { result: { ...TASK, status: "working" } };
      }
      return {
        result: {
          ...TASK,
          resultType: "complete",
          status: "completed",
          result: { content: [{ type: "text", text: "ok" }] },
        },
      };
    }),
    info: CLIENT_INFO,
    tasks: { initialPollMs: 1 },
  });
  assertEquals((await client.callTool("x")).content, [{
    type: "text",
    text: "ok",
  }]);
  const broken = new McpClient({
    transport: scripted((message) =>
      message.method === "tools/call"
        ? { result: TASK }
        : { result: { ...TASK, resultType: "complete", status: "completed" } }
    ),
    info: CLIENT_INFO,
    tasks: { initialPollMs: 1 },
  });
  assertEquals((await failure(broken.callTool("x"))).kind, "decode");
});

Deno.test("transient poll failures are retried", async () => {
  let polls = 0;
  const client = new McpClient({
    transport: {
      request(message) {
        if (message.method === "tools/call") {
          return Promise.resolve({
            jsonrpc: "2.0",
            id: message.id,
            result: TASK,
          });
        }
        polls++;
        if (polls <= 2) {
          return Promise.reject(new McpError("connection", "flaky"));
        }
        return Promise.resolve({
          jsonrpc: "2.0",
          id: message.id,
          result: {
            ...TASK,
            resultType: "complete",
            status: "completed",
            result: { content: [] },
          },
        });
      },
    },
    info: CLIENT_INFO,
    tasks: { initialPollMs: 1, maxPollMs: 2 },
  });
  assertEquals((await client.callTool("x")).content, []);
  assertEquals(polls, 3);
});

Deno.test("a task's result is checked against the tool's output schema", async () => {
  const client = new McpClient({
    transport: scripted((message) => {
      switch (message.method) {
        case "tools/list":
          return {
            result: {
              resultType: "complete",
              tools: [{
                name: "x",
                inputSchema: { type: "object" },
                outputSchema: {
                  type: "object",
                  properties: { n: { type: "integer" } },
                  required: ["n"],
                },
              }],
            },
          };
        case "tools/call":
          return { result: TASK };
        default:
          return {
            result: {
              ...TASK,
              resultType: "complete",
              status: "completed",
              result: { content: [], structuredContent: { n: "one" } },
            },
          };
      }
    }),
    info: CLIENT_INFO,
    tasks: { initialPollMs: 1 },
  });
  await client.listTools();
  const error = await failure(client.callTool("x"));
  assertEquals(error.kind, "decode");
  assert(error.message.includes("outputSchema"), error.message);
});

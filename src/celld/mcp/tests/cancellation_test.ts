// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

import { assert, assertEquals } from "@celld/core/assert";
import {
  LATEST_PROTOCOL_VERSION,
  McpClient,
  McpError,
  mcpHttpHandler,
  McpServer,
  MemoryChangeSource,
  META,
  type TaskRecord,
  TASKS_EXTENSION,
  UnsafeMemoryTaskStore,
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
  const handler = mcpHttpHandler(server, { public: true });
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
    fetch: handlerFetch(mcpHttpHandler(server, { public: true })),
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

/**
 * A server whose `stubborn` tool ignores its signal: it settles only when
 * the test says, so an abort must win without its help.
 */
function stubborn() {
  const tasks = new UnsafeMemoryTaskStore();
  const server = new McpServer({ info: SERVER_INFO, tasks: { store: tasks } });
  const state = { started: 0, finished: 0 };
  let settle: (outcome: { value: string } | { error: Error }) => void =
    () => {};
  let started: () => void = () => {};
  const running = new Promise<void>((resolve) => {
    started = resolve;
  });
  const body = (progress: (value: number) => void) =>
    new Promise<string>((resolve, reject) => {
      state.started++;
      progress(1);
      started();
      settle = (outcome) => {
        state.finished++;
        if ("value" in outcome) resolve(outcome.value);
        else reject(outcome.error);
      };
    });
  server.tool({
    name: "stubborn",
    run: (_args, ctx) => body(ctx.progress),
    task: { run: () => body(() => {}) },
  });
  return {
    server,
    state,
    running,
    settle: (outcome: { value: string } | { error: Error }) => settle(outcome),
  };
}

/** The value of `promise`, or "pending" if it has not settled within `ms`. */
async function within<T>(
  promise: Promise<T>,
  ms = 200,
): Promise<T | "pending"> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<"pending">((resolve) => {
        timer = setTimeout(() => resolve("pending"), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** Collects unhandled rejections while `work` runs, and a little after. */
async function unhandled(work: () => Promise<void>): Promise<unknown[]> {
  const seen: unknown[] = [];
  const onRejection = (event: PromiseRejectionEvent) => {
    seen.push(event.reason);
    event.preventDefault();
  };
  globalThis.addEventListener("unhandledrejection", onRejection);
  try {
    await work();
    await new Promise((resolve) => setTimeout(resolve, 10));
  } finally {
    globalThis.removeEventListener("unhandledrejection", onRejection);
  }
  return seen;
}

Deno.test("an abort wins over a handler that ignores its signal", async () => {
  const rejections = await unhandled(async () => {
    const { server, state, running, settle } = stubborn();
    const stop = new AbortController();
    const done = server.handle(request("tools/call", { name: "stubborn" }), {
      signal: stop.signal,
    });
    await running;
    stop.abort();
    assertEquals(await within(done), null);
    // The abandoned handler fails later: nothing is sent, nothing leaks.
    settle({ error: new Error("late failure") });
    await new Promise((resolve) => setTimeout(resolve, 0));
    assertEquals(state, { started: 1, finished: 1 });
  });
  assertEquals(rejections, []);
});

Deno.test("a client leaving an HTTP request gets 499 at once, and the late result is dropped", async () => {
  const rejections = await unhandled(async () => {
    const { server, running, settle } = stubborn();
    const handler = mcpHttpHandler(server, { public: true });
    const post = (signal: AbortSignal, progress: boolean) =>
      handler(
        new Request("https://mcp.test/", {
          method: "POST",
          signal,
          headers: {
            "content-type": "application/json",
            accept: "application/json, text/event-stream",
            "mcp-protocol-version": "2026-07-28",
            "mcp-method": "tools/call",
            "mcp-name": "stubborn",
          },
          body: JSON.stringify(
            request("tools/call", { name: "stubborn" }, {
              meta: progress ? { [META.progressToken]: "t" } : {},
            }),
          ),
        }),
      );

    // A JSON answer: the client goes away before it.
    const stop = new AbortController();
    const pending = post(stop.signal, false);
    await running;
    stop.abort();
    const response = await within(pending);
    assert(response !== "pending", "the response waited for the handler");
    assertEquals(response.status, 499);
    settle({ value: "too late" });

    // A stream: closing it ends the request without the handler's help.
    const streamed = await post(new AbortController().signal, true);
    assertEquals(streamed.headers.get("content-type"), "text/event-stream");
    const reader = streamed.body!.getReader();
    await reader.read(); // the progress notification
    const errors: unknown[] = [];
    const error = console.error;
    console.error = (...args: unknown[]) => errors.push(args);
    try {
      await reader.cancel();
      settle({ error: new Error("late failure") });
      await new Promise((resolve) => setTimeout(resolve, 0));
    } finally {
      console.error = error;
    }
    // The request ended with the stream, before the handler failed.
    assertEquals(errors, []);
  });
  assertEquals(rejections, []);
});

Deno.test("a task body that ignores its signal is released when the task stops", async () => {
  const rejections = await unhandled(async () => {
    const { server, running, settle } = stubborn();
    const stop = new AbortController();
    const record: TaskRecord = {
      version: 2,
      taskId: "t-1",
      owner: "capability:test",
      scopes: [],
      principal: null,
      method: "tools/call",
      name: "stubborn",
      arguments: {},
      protocolVersion: LATEST_PROTOCOL_VERSION,
      clientCapabilities: { extensions: { [TASKS_EXTENSION]: {} } },
      clientInfo: CLIENT_INFO,
      status: "working",
      statusMessage: null,
      createdAt: 0,
      lastUpdatedAt: 0,
      ttlMs: null,
      pollIntervalMs: 1000,
      outstanding: {},
      asked: {},
      answers: {},
      state: null,
      result: null,
      error: null,
      runAt: 0,
      runs: 1,
    };
    const outcome = server.taskRunner.run(record, {
      signal: stop.signal,
      status: () => Promise.resolve(),
      save: () => Promise.resolve(),
    });
    await running;
    stop.abort();
    assertEquals(await within(outcome), {
      type: "failed",
      error: { code: -32603, message: "The task was stopped" },
    });
    settle({ value: "too late" });
  });
  assertEquals(rejections, []);
});

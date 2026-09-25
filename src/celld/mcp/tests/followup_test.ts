// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * Regressions for the findings other wave-4 sweepers filed to WP-13
 * against `@celld/mcp` (the WP-13b follow-up): bounded reads and numbers,
 * queues and lists with caps, peer-chosen keys, abandoned work, stale
 * caches, regular expressions on peer input, and listen visibility. Each
 * is named by its `DB-SWP` identifier and failed on the code before it.
 *
 * @module
 */

import { assert, assertEquals } from "@celld/core/assert";
import {
  ChangeLog,
  compileSchema,
  compileUriTemplate,
  httpTransport,
  type JSONRPCNotification,
  type JSONRPCResponse,
  LATEST_PROTOCOL_VERSION,
  McpClient,
  McpError,
  mcpHttpHandler,
  McpServer,
  memoryCache,
  MemoryChangeSource,
  META,
  pollingChangeSource,
  SchemaError,
  TASKS_EXTENSION,
  type Transport,
  unsafeMemoryIdempotencyStore,
  UnsafeMemoryTaskStore,
} from "@celld/mcp";
import { inProcessTransport, testPrincipal } from "@celld/mcp/testing";
import {
  CLIENT_INFO,
  demoServer,
  errorOf,
  request,
  resultOf,
  SERVER_INFO,
} from "./fixture.ts";

const TASK_CAPS = { extensions: { [TASKS_EXTENSION]: {} } };
const IDEMPOTENCY = "celld/idempotency-key";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function rangeError(make: () => unknown, what: string): void {
  let threw: unknown;
  try {
    make();
  } catch (error) {
    threw = error;
  }
  assert(
    threw instanceof RangeError,
    `${what}: expected a RangeError, got ${threw}`,
  );
}

async function mcpFailure(promise: Promise<unknown>): Promise<McpError> {
  try {
    await promise;
  } catch (error) {
    assert(error instanceof McpError, `not an McpError: ${error}`);
    return error;
  }
  throw new Error("resolved");
}

function within<T>(promise: Promise<T>, ms: number): Promise<T | "hung"> {
  let timer: number | undefined;
  return Promise.race([
    promise,
    new Promise<"hung">((resolve) => {
      timer = setTimeout(() => resolve("hung"), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

/** A POST of `body` to an MCP handler, with the standard headers. */
function post(body: string, method = "tools/call", name?: string): Request {
  return new Request("https://mcp.test/mcp", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "mcp-method": method,
      "mcp-protocol-version": LATEST_PROTOCOL_VERSION,
      ...(name === undefined ? {} : { "mcp-name": name }),
    },
    body,
  });
}

/** An HTTP transport over a canned answer. */
function answering(
  answer: () => Response,
  options: { maxResponseBytes?: number; maxStreamBytes?: number } = {},
): Transport {
  return httpTransport("https://mcp.test/mcp", {
    fetch: () => Promise.resolve(answer()),
    ...options,
  });
}

const noop = {
  signal: new AbortController().signal,
  headers: {},
  onNotification: () => {},
};

function sse(chunks: string[]): Response {
  const encoder = new TextEncoder();
  return new Response(
    new ReadableStream({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
        controller.close();
      },
    }),
    { headers: { "content-type": "text/event-stream" } },
  );
}

function nested(depth: number): string {
  return "[".repeat(depth) + "]".repeat(depth);
}

// ----- DB-SWP-F1-201 / DB-SWP-F2-201 / DB-SWP-F2-01: the client transport's reads -----

Deno.test("DB-SWP-F1-201: the HTTP transport caps JSON answers, SSE streams and events", async () => {
  const message = request("tools/call", { name: "echo", arguments: {} });
  const big = JSON.stringify({
    jsonrpc: "2.0",
    id: message.id,
    result: { content: [], pad: "x".repeat(8192) },
  });
  const tooBig = await mcpFailure(
    answering(
      () =>
        new Response(big, { headers: { "content-type": "application/json" } }),
      { maxResponseBytes: 4096 },
    ).request(message, noop),
  );
  assertEquals(tooBig.kind, "decode");
  const deep = await mcpFailure(
    answering(() =>
      new Response(
        `{"jsonrpc":"2.0","id":${message.id},"result":{"x":${nested(200)}}}`,
        { headers: { "content-type": "application/json" } },
      )
    ).request(message, noop),
  );
  assertEquals(deep.kind, "decode", "a too-deep answer is not a JSON-RPC body");
  const progress = `event: message\ndata: ${
    JSON.stringify({
      jsonrpc: "2.0",
      method: "notifications/progress",
      params: { progressToken: "p", progress: 1 },
    })
  }\n\n`;
  const endless = await mcpFailure(
    answering(() => sse(Array.from({ length: 200 }, () => progress)), {
      maxStreamBytes: 4096,
    }).request(message, noop),
  );
  assertEquals([endless.kind, endless.accepted], ["stream", true]);
  const huge = await mcpFailure(
    answering(
      () => sse([`event: message\ndata: "${"x".repeat(8192)}"\n\n`]),
      { maxResponseBytes: 4096 },
    ).request(message, noop),
  );
  assertEquals(huge.kind, "decode");
  const deepEvent = await mcpFailure(
    answering(() => sse([`event: message\ndata: ${nested(200)}\n\n`]))
      .request(message, noop),
  );
  assertEquals(deepEvent.kind, "decode");
  rangeError(
    () => httpTransport("https://mcp.test/mcp", { maxResponseBytes: NaN }),
    "maxResponseBytes",
  );
});

// ----- DB-SWP-F1-202: the server parses bodies under depth limits -----

Deno.test("DB-SWP-F1-202: a POST body nested past the limit is a parse error", async () => {
  const server = new McpServer({ info: SERVER_INFO });
  server.tool({
    name: "any",
    input: { type: "object" },
    run: () => "ran",
  });
  const handler = mcpHttpHandler(server, { public: true });
  const body =
    `{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"any","arguments":{"a":${
      nested(500)
    }},"_meta":{}}}`;
  const response = await handler(post(body, "tools/call", "any"));
  assertEquals(response.status, 400);
  assertEquals((await response.json()).error.code, -32700);
});

// ----- DB-SWP-F7-201 / DB-SWP-F7-01: server numbers -----

Deno.test("DB-SWP-F7-201: server cache, state and listen numbers are checked or clamped", async () => {
  for (const ttlMs of [Infinity, NaN, -1, 86_400_001]) {
    rangeError(
      () => new McpServer({ info: SERVER_INFO, cache: { ttlMs } }),
      `cache.ttlMs ${ttlMs}`,
    );
  }
  rangeError(
    () => new McpServer({ info: SERVER_INFO, listenLifetimeMs: 0 }),
    "listenLifetimeMs 0 (was: never)",
  );
  rangeError(
    () => new McpServer({ info: SERVER_INFO, stateTtlMs: 0 }),
    "stateTtlMs 0",
  );
  const server = new McpServer({ info: SERVER_INFO });
  server.resource({
    uri: "forever://x",
    name: "forever",
    read: () => ({
      contents: [{ uri: "forever://x", text: "x" }],
      ttlMs: Infinity,
    }),
  });
  const read = resultOf(
    await server.handle(request("resources/read", { uri: "forever://x" })),
  );
  assertEquals(read.ttlMs, 86_400_000);
});

// ----- DB-SWP-F7-202: keep-alive interval -----

Deno.test("DB-SWP-F7-202: keepAliveMs and maxBufferedBytes are checked", () => {
  const server = demoServer();
  for (const keepAliveMs of [2 ** 31, NaN, -1, Infinity]) {
    rangeError(
      () => mcpHttpHandler(server, { public: true, keepAliveMs }),
      `keepAliveMs ${keepAliveMs}`,
    );
  }
  rangeError(
    () => mcpHttpHandler(server, { public: true, maxBufferedBytes: 10 }),
    "maxBufferedBytes",
  );
});

// ----- DB-SWP-F7-203: client numbers -----

Deno.test("DB-SWP-F7-203: client timeouts, rounds and poll settings are checked", async () => {
  const transport = inProcessTransport(demoServer());
  const make = (extra: Record<string, unknown>) => () =>
    new McpClient({ transport, info: CLIENT_INFO, ...extra });
  for (
    const [what, extra] of [
      ["timeoutMs NaN", { timeoutMs: NaN }],
      ["timeoutMs 2^31", { timeoutMs: 2 ** 31 }],
      ["maxTimeoutMs Infinity", { maxTimeoutMs: Infinity }],
      ["maxInputRounds Infinity", { maxInputRounds: Infinity }],
      ["tasks.initialPollMs -1", { tasks: { initialPollMs: -1 } }],
      ["tasks.maxPollErrors 1e9", { tasks: { maxPollErrors: 1e9 } }],
      ["tasks.minPollMs 0", { tasks: { minPollMs: 0 } }],
    ] as const
  ) {
    rangeError(make(extra), what);
  }
  rangeError(
    () => httpTransport("https://mcp.test/mcp", { maxAuthAttempts: NaN }),
    "maxAuthAttempts",
  );
  const client = new McpClient({ transport, info: CLIENT_INFO });
  const failure = await mcpFailure(
    client.callTool("echo", { text: "x" }, { timeoutMs: NaN }),
  );
  assertEquals(failure.kind, "invalid_request");
});

// ----- DB-SWP-F7-204: server numbers on the client -----

/** A task server whose answers are rewritten on the way to the client. */
function rewriting(
  server: McpServer,
  rewrite: (result: Record<string, unknown>) => void,
) {
  const inner = inProcessTransport(server);
  const methods: string[] = [];
  const transport: Transport = {
    async request(message, options) {
      methods.push(message.method);
      const response = await inner.request(message, options);
      if ("result" in response) {
        rewrite(response.result as Record<string, unknown>);
      }
      return response;
    },
  };
  return { transport, methods };
}

Deno.test("DB-SWP-F7-204: a server's poll interval of 0 does not make the client spin", async () => {
  const release = { done: false };
  const server = new McpServer({
    info: SERVER_INFO,
    tasks: { store: new UnsafeMemoryTaskStore(), pollIntervalMs: 10 },
  });
  server.tool({
    name: "wait",
    task: {
      run: async () => {
        while (!release.done) await sleep(10);
        return "done";
      },
    },
  });
  const { transport, methods } = rewriting(server, (result) => {
    if ("pollIntervalMs" in result) result.pollIntervalMs = 0;
    const task = result.task as Record<string, unknown> | undefined;
    if (task !== undefined) task.pollIntervalMs = 0;
  });
  const client = new McpClient({ transport, info: CLIENT_INFO, tasks: true });
  const done = client.callTool("wait");
  await sleep(300);
  release.done = true;
  await done;
  const polls = methods.filter((method) => method === "tasks/get").length;
  assert(polls <= 10, `polled ${polls} times in 300 ms`);
});

Deno.test("DB-SWP-F7-204: a server's huge ttlMs is cached for a day at most", async () => {
  const { transport, methods } = rewriting(demoServer(), (result) => {
    if ("ttlMs" in result) result.ttlMs = 1e300;
    if ("cacheScope" in result) result.cacheScope = "public";
  });
  let now = 1_000_000;
  const client = new McpClient({
    transport,
    info: CLIENT_INFO,
    cache: memoryCache(),
    now: () => now,
  });
  await client.listTools();
  await client.listTools();
  assertEquals(methods.length, 1, "cached");
  now += 86_400_001;
  await client.listTools();
  assertEquals(methods.length, 2, "expired after a day");
});

// ----- DB-SWP-F7-205: change sources -----

Deno.test("DB-SWP-F7-205: change log and polling numbers are checked", () => {
  for (const capacity of [NaN, 0, -1, 1e9]) {
    rangeError(() => new ChangeLog({ capacity }), `capacity ${capacity}`);
  }
  const poll = () => Promise.reject(new Error("down"));
  for (
    const options of [
      { errorDelayMs: 0 },
      { errorDelayMs: NaN },
      { waitMs: -1 },
      { waitMs: 2 ** 31 },
    ]
  ) {
    rangeError(
      () => pollingChangeSource(poll, options),
      JSON.stringify(options),
    );
  }
});

// ----- DB-SWP-F7-206: schema limits -----

Deno.test("DB-SWP-F7-206: schema limits must be whole numbers", () => {
  for (
    const limits of [
      { maxDepth: NaN },
      { maxSubschemas: -1 },
      { maxSteps: NaN },
      { maxRefDepth: Infinity },
    ]
  ) {
    rangeError(
      () => compileSchema({ type: "string" }, limits),
      JSON.stringify(limits),
    );
  }
});

// ----- DB-SWP-F8-201: memory cache size -----

Deno.test("DB-SWP-F8-201: memoryCache refuses a size that cannot evict", () => {
  for (const size of [-1, 0, NaN, 1.5]) {
    rangeError(() => memoryCache(size), `maxEntries ${size}`);
  }
  const cache = memoryCache(2);
  for (const key of ["a", "b", "c"]) {
    cache.set(key, {
      result: { resultType: "complete" },
      expiresAt: 1,
      method: "tools/list",
    });
  }
  assertEquals(cache.size, 2);
});

// ----- DB-SWP-F8-202: listAllTools caps -----

Deno.test("DB-SWP-F8-202: listAllTools stops on a cursor loop and forgets delisted tools", async () => {
  let pages = 0;
  const looping: Transport = {
    request(message) {
      pages++;
      return Promise.resolve({
        jsonrpc: "2.0",
        id: message.id,
        result: {
          resultType: "complete",
          tools: [{ name: `t${pages}`, inputSchema: { type: "object" } }],
          nextCursor: "same",
        },
      } as JSONRPCResponse);
    },
  };
  const client = new McpClient({ transport: looping, info: CLIENT_INFO });
  const outcome = await within(
    client.listAllTools().catch((error: unknown) => error),
    2000,
  );
  assert(
    outcome instanceof McpError && outcome.kind === "decode",
    `ended with ${outcome}`,
  );
  assert(pages <= 2, `followed ${pages} pages`);
});

// ----- DB-SWP-F8-203: listen queues -----

Deno.test("DB-SWP-F8-203: a listener that does not read gets a reset, not an unbounded queue", async () => {
  const source = new MemoryChangeSource();
  const stop = new AbortController();
  const events = await source.listen(stop.signal);
  for (let i = 0; i < 5000; i++) {
    source.publish({ type: "resource", uri: `r:${i}` });
  }
  const iterator = events[Symbol.asyncIterator]();
  const first = await iterator.next();
  assertEquals(first.value, { type: "reset" });
  stop.abort();
});

Deno.test("DB-SWP-F8-203: the client fails a subscription whose notifications are not read", async () => {
  const flood: Transport = {
    request(message, { onNotification, signal }) {
      const tag = { [META.subscriptionId]: message.id };
      onNotification({
        jsonrpc: "2.0",
        method: "notifications/subscriptions/acknowledged",
        params: { notifications: { toolsListChanged: true }, _meta: tag },
      } as JSONRPCNotification);
      for (let i = 0; i < 5000 && !signal.aborted; i++) {
        onNotification({
          jsonrpc: "2.0",
          method: "notifications/tools/list_changed",
          params: { _meta: tag },
        } as JSONRPCNotification);
      }
      return new Promise((_, reject) =>
        signal.addEventListener("abort", () => reject(new Error("closed")))
      );
    },
  };
  const client = new McpClient({ transport: flood, info: CLIENT_INFO });
  const subscription = client.listen({ toolsListChanged: true });
  let read = 0;
  const outcome = await within(
    (async () => {
      try {
        for await (const _ of subscription) read++;
      } catch (error) {
        return error;
      }
      return "ended";
    })(),
    2000,
  );
  subscription.close();
  assert(
    outcome instanceof McpError && outcome.kind === "stream",
    `ended with ${outcome}`,
  );
  assert(read <= 1000, `read ${read}`);
});

Deno.test("DB-SWP-F8-203: an SSE stream whose reader stopped reading is closed", async () => {
  const source = new MemoryChangeSource();
  const server = new McpServer({ info: SERVER_INFO, changes: source });
  server.tool({ name: "t", run: () => "" });
  const handler = mcpHttpHandler(server, {
    public: true,
    maxBufferedBytes: 64 * 1024,
  });
  const listen = request("subscriptions/listen", {
    notifications: { toolsListChanged: true },
  });
  const response = await handler(
    post(JSON.stringify(listen), "subscriptions/listen"),
  );
  assertEquals(response.status, 200);
  // Nobody reads the body; the server publishes a lot.
  for (let i = 0; i < 20_000 && source.listeners > 0; i++) {
    source.publish({ type: "tools" });
    if (i % 100 === 0) await sleep(0);
  }
  await sleep(10);
  assertEquals(source.listeners, 0, "the stream was closed and detached");
  await response.body?.cancel();
});

// ----- DB-SWP-F8-204: listen request sizes -----

Deno.test("DB-SWP-F8-204: a listen request names at most 100 tasks and 1000 resources", async () => {
  const server = new McpServer({
    info: SERVER_INFO,
    changes: new MemoryChangeSource(),
    tasks: { store: new UnsafeMemoryTaskStore() },
  });
  server.tool({ name: "t", run: () => "" });
  server.resource({ uri: "r://x", name: "x", read: () => "x" });
  const many = (n: number, prefix: string) =>
    Array.from({ length: n }, (_, i) => `${prefix}${i}`);
  for (
    const notifications of [
      { taskIds: many(101, "t") },
      { resourceSubscriptions: many(1001, "r://") },
      { resourceSubscriptions: [`r://${"x".repeat(9000)}`] },
    ]
  ) {
    const answer = await server.handle(
      request("subscriptions/listen", { notifications }, {
        capabilities: TASK_CAPS,
      }),
      { emit: () => {} },
    );
    assertEquals(errorOf(answer).code, -32602);
  }
});

// ----- DB-SWP-F8-205: memory task store -----

Deno.test("DB-SWP-F8-205: the memory task store holds at most maxTasks live tasks", async () => {
  rangeError(() => new UnsafeMemoryTaskStore({ maxTasks: NaN }), "maxTasks");
  const server = new McpServer({
    info: SERVER_INFO,
    tasks: { store: new UnsafeMemoryTaskStore({ maxTasks: 2 }) },
  });
  server.tool({
    name: "slow",
    task: { run: () => new Promise<string>(() => {}) },
  });
  const start = async () =>
    await server.handle(
      request("tools/call", { name: "slow", arguments: {} }, {
        capabilities: TASK_CAPS,
      }),
      { principal: testPrincipal("u") },
    );
  resultOf(await start());
  resultOf(await start());
  const third = errorOf(await start());
  assertEquals(third.code, -32603);
});

// ----- DB-SWP-F9-101..105: peer-chosen names -----

Deno.test("DB-SWP-F9-101: a discriminator named after Object.prototype is refused", async () => {
  const server = demoServer();
  for (
    const type of ["toString", "constructor", "hasOwnProperty", "__proto__"]
  ) {
    const answer = await server.handle(
      request("completion/complete", {
        ref: { type },
        argument: { name: "x", value: "" },
      }),
    );
    assertEquals(errorOf(answer).code, -32602, type);
  }
});

Deno.test("DB-SWP-F9-102: tasks/update ignores keys that were never asked", async () => {
  const server = new McpServer({
    info: SERVER_INFO,
    tasks: { store: new UnsafeMemoryTaskStore() },
  });
  server.tool({
    name: "slow",
    task: { run: () => new Promise<string>(() => {}) },
  });
  const principal = testPrincipal("u");
  const created = resultOf(
    await server.handle(
      request("tools/call", { name: "slow", arguments: {} }, {
        capabilities: TASK_CAPS,
      }),
      { principal },
    ),
  );
  const taskId = created.taskId as string;
  for (const key of ["toString", "constructor", "__proto__"]) {
    // As JSON.parse would make it: an own key, even `__proto__`.
    const answer = await server.handle(
      request("tasks/update", {
        taskId,
        inputResponses: JSON.parse(`{"${key}":{}}`),
      }, { capabilities: TASK_CAPS }),
      { principal },
    );
    resultOf(answer);
  }
});

Deno.test("DB-SWP-F9-103: completing an argument named after Object.prototype completes nothing", async () => {
  const server = demoServer();
  for (const name of ["constructor", "toString", "__proto__"]) {
    const answer = resultOf(
      await server.handle(request("completion/complete", {
        ref: { type: "ref/prompt", name: "greet" },
        argument: { name, value: "" },
      })),
    );
    assertEquals(answer.completion, { values: [], total: 0 }, name);
  }
});

Deno.test("DB-SWP-F9-104: a method named after Object.prototype is method-not-found", async () => {
  const handler = mcpHttpHandler(demoServer(), { public: true });
  for (const method of ["constructor", "toString"]) {
    const response = await handler(
      post(JSON.stringify(request(method)), method),
    );
    const answer = await response.json();
    assertEquals(answer.error.code, -32601, method);
  }
});

Deno.test("DB-SWP-F9-105: the client refuses notifications and statuses named after Object.prototype", async () => {
  const warnings: string[] = [];
  const odd: Transport = {
    request(message, { onNotification }) {
      onNotification({
        jsonrpc: "2.0",
        method: "toString",
        params: {},
      } as JSONRPCNotification);
      return Promise.resolve({
        jsonrpc: "2.0",
        id: message.id,
        result: { resultType: "complete", content: [] },
      } as JSONRPCResponse);
    },
  };
  const client = new McpClient({
    transport: odd,
    info: CLIENT_INFO,
    onWarning: (message) => warnings.push(message),
  });
  await client.callTool("x");
  assert(
    warnings.some((warning) => warning.includes("unknown notification")),
    `warned: ${warnings}`,
  );
  // An input request keyed __proto__ is answered under that key.
  const server = demoServer();
  const inner = inProcessTransport(server);
  const asked: string[] = [];
  const renamed: Transport = {
    async request(message, options) {
      const params = message.params as Record<string, unknown>;
      const responses = params.inputResponses as
        | Record<string, unknown>
        | undefined;
      if (responses !== undefined && Object.hasOwn(responses, "__proto__")) {
        asked.push("answered");
        const text = JSON.stringify(message).replace(
          '"__proto__":',
          '"github":',
        );
        return await inner.request(JSON.parse(text), options);
      }
      const response = await inner.request(message, options);
      const text = JSON.stringify(response).replace(
        '"github":',
        '"__proto__":',
      );
      return JSON.parse(text);
    },
  };
  const loginClient = new McpClient({
    transport: renamed,
    info: CLIENT_INFO,
    handlers: {
      elicitation: () => ({ action: "accept", content: { login: "octo" } }),
    },
  });
  const result = await loginClient.callTool("login");
  assertEquals(asked, ["answered"]);
  assertEquals(result.content, [{ type: "text", text: "hello octo" }]);
});

// ----- DB-SWP-F10-108: idempotent completions are held by waitUntil -----

Deno.test("DB-SWP-F10-108: a keyed call's record and abandoned work are held with waitUntil", async () => {
  const release = { done: false };
  const server = new McpServer({
    info: SERVER_INFO,
    idempotency: { store: unsafeMemoryIdempotencyStore() },
  });
  server.tool({
    name: "charge",
    run: async () => {
      while (!release.done) await sleep(5);
      return "charged";
    },
  });
  const held: Promise<unknown>[] = [];
  const leave = new AbortController();
  const call = () =>
    request("tools/call", { name: "charge", arguments: {} }, {
      meta: { [IDEMPOTENCY]: "k1" },
    });
  const first = server.handle(call(), {
    principal: testPrincipal("u"),
    signal: leave.signal,
    waitUntil: (promise) => held.push(promise),
  });
  await sleep(20);
  leave.abort();
  assertEquals(await first, null);
  assert(held.length >= 1, "the completion is held");
  release.done = true;
  await Promise.all(held);
  const again = resultOf(
    await server.handle(call(), { principal: testPrincipal("u") }),
  );
  assertEquals(again.content, [{ type: "text", text: "charged" }]);
});

// ----- DB-SWP-F10-109: abort reports whether the task was cancelled -----

Deno.test("DB-SWP-F10-109: an aborted task call says whether the cancel reached the server", async () => {
  const server = new McpServer({
    info: SERVER_INFO,
    tasks: { store: new UnsafeMemoryTaskStore(), pollIntervalMs: 10 },
  });
  server.tool({
    name: "slow",
    task: { run: () => new Promise<string>(() => {}) },
  });
  const inner = inProcessTransport(server, { principal: testPrincipal("u") });
  const refusing: Transport = {
    request: (message, options) =>
      message.method === "tasks/cancel"
        ? Promise.reject(new McpError("connection", "reset"))
        : inner.request(message, options),
  };
  const warnings: string[] = [];
  const client = new McpClient({
    transport: refusing,
    info: CLIENT_INFO,
    tasks: true,
    onWarning: (message) => warnings.push(message),
  });
  const controller = new AbortController();
  const done = client.callTool("slow", {}, { signal: controller.signal });
  await sleep(50);
  controller.abort();
  const failure = await mcpFailure(done);
  assertEquals(failure.kind, "aborted");
  assertEquals((failure.data as { cancelled?: boolean }).cancelled, false);
  assert(
    warnings.some((w) => w.includes("may still be running")),
    `${warnings}`,
  );
});

// ----- DB-SWP-F10-110: a closed listen stream stops waiting on its poll -----

Deno.test("DB-SWP-F10-110: the polling source returns as soon as its signal aborts", async () => {
  let polls = 0;
  const source = pollingChangeSource(
    (cursor, waitMs) => {
      polls++;
      if (cursor === null) {
        return Promise.resolve({
          epoch: "e",
          seq: 0,
          events: [],
          reset: false,
        });
      }
      // A long poll that answers only after its window.
      return new Promise((resolve) =>
        setTimeout(
          () => resolve({ epoch: "e", seq: 0, events: [], reset: false }),
          waitMs,
        )
      );
    },
    { waitMs: 5000 },
  );
  const stop = new AbortController();
  const events = await source.listen(stop.signal);
  const iterator = events[Symbol.asyncIterator]();
  const next = iterator.next();
  await sleep(20);
  stop.abort();
  const settled = await within(next, 500);
  assert(settled !== "hung", "the iterator ended without waiting out the poll");
  assertEquals(polls, 2);
});

// ----- DB-SWP-F12-116: an in-flight answer does not undo an invalidation -----

Deno.test("DB-SWP-F12-116: a list fetched across a list_changed is not cached", async () => {
  // Public cache hints, so a client without a cacheContext caches lists.
  const inner = inProcessTransport(
    demoServer({ cache: { ttlMs: 60_000, scope: "public" } }),
  );
  let changed!: () => void;
  const change = new Promise<void>((resolve) => changed = resolve);
  let lists = 0;
  const transport: Transport = {
    async request(message, options) {
      if (message.method === "subscriptions/listen") {
        // A listen stream that reports one list change when asked.
        const tag = { [META.subscriptionId]: message.id };
        options.onNotification({
          jsonrpc: "2.0",
          method: "notifications/subscriptions/acknowledged",
          params: { notifications: { toolsListChanged: true }, _meta: tag },
        } as JSONRPCNotification);
        await change;
        options.onNotification({
          jsonrpc: "2.0",
          method: "notifications/tools/list_changed",
          params: { _meta: tag },
        } as JSONRPCNotification);
        return await new Promise<JSONRPCResponse>((resolve) =>
          options.signal.addEventListener("abort", () =>
            resolve({
              jsonrpc: "2.0",
              id: message.id,
              result: {},
            } as JSONRPCResponse))
        );
      }
      if (message.method === "tools/list" && ++lists === 1) {
        // The server computed this list before the change: the change
        // arrives while its answer is still on the way.
        const answer = await inner.request(message, options);
        changed();
        await sleep(20);
        return answer;
      }
      return await inner.request(message, options);
    },
  };
  const client = new McpClient({
    transport,
    info: CLIENT_INFO,
    cache: memoryCache(),
  });
  const subscription = client.listen({ toolsListChanged: true });
  await subscription.acknowledged;
  await client.listTools();
  await client.listTools();
  subscription.close();
  assertEquals(lists, 2, "the list fetched across the change was not cached");
});

// ----- DB-SWP-F14-117: URI templates match in linear time -----

Deno.test("DB-SWP-F14-117: a URI template match cannot be made to backtrack", async () => {
  const template = compileUriTemplate("file://{name}.{ext}");
  assertEquals(template.match("file://a.b.c"), ["a.b", "c"]);
  assertEquals(template.match("file://a/b.c"), null);
  const reserved = compileUriTemplate("repo://{+path}/{+file}.json");
  assertEquals(reserved.match("repo://a/b/c.json"), ["a", "b/c"]);
  const evil = `file://${"a.".repeat(4000)}/`;
  const started = performance.now();
  assertEquals(template.match(evil), null);
  const tripled = compileUriTemplate("x://{+a}/{+b}/{+c}.json");
  assertEquals(tripled.match(`x://${"/".repeat(4000)}`), null);
  const elapsed = performance.now() - started;
  assert(elapsed < 500, `took ${elapsed} ms`);
  // And a request names at most 8 KiB of URI.
  const server = new McpServer({ info: SERVER_INFO });
  server.resourceTemplate({
    uriTemplate: "file://{name}.{ext}",
    name: "files",
    read: (uri) => [{ uri, text: "x" }],
  });
  const long = await server.handle(
    request("resources/read", { uri: `file://${"a".repeat(9000)}.txt` }),
  );
  assertEquals(errorOf(long).code, -32602);
});

// ----- DB-SWP-F14-118: patterns from untrusted schemas -----

Deno.test("DB-SWP-F14-118: a peer's schema patterns are never run", () => {
  const hostile = { type: "string", pattern: "^(a|a)*$" };
  const started = performance.now();
  assertEquals(compileSchema(hostile).validate("a".repeat(40) + "!"), []);
  assert(performance.now() - started < 500, "the pattern was not run");
  let refused: unknown;
  try {
    compileSchema({ type: "object", patternProperties: { "^(a|a)*$": {} } });
  } catch (error) {
    refused = error;
  }
  assert(refused instanceof SchemaError, "patternProperties is refused");
  // The program's own schemas still enforce their patterns.
  assertEquals(
    compileSchema({ type: "string", pattern: "^a" }, { trustPatterns: true })
      .validate("b").length,
    1,
  );
});

// ----- WP-13 review note: listen visibility -----

Deno.test("DB-SWP-F4-13b.M1: a listen stream does not watch resources hidden from the caller", async () => {
  const server = new McpServer({
    info: SERVER_INFO,
    changes: new MemoryChangeSource(),
  });
  server.resource({
    uri: "secret://plan",
    name: "plan",
    visible: (info) => info.principal?.scopes.includes("admin") ?? false,
    read: () => "plan",
  });
  server.resource({ uri: "public://news", name: "news", read: () => "news" });
  const acknowledged: unknown[] = [];
  const leave = new AbortController();
  const open = server.handle(
    request("subscriptions/listen", {
      notifications: {
        resourceSubscriptions: [
          "secret://plan",
          "public://news",
          "dynamic://x",
        ],
      },
    }),
    {
      principal: testPrincipal("u"),
      signal: leave.signal,
      emit: (notification) => {
        if (
          notification.method === "notifications/subscriptions/acknowledged"
        ) {
          acknowledged.push(notification.params?.notifications);
        }
      },
    },
  );
  await sleep(20);
  leave.abort();
  await open;
  assertEquals(acknowledged, [{
    resourceSubscriptions: ["public://news", "dynamic://x"],
  }]);
});

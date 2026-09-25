// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * Regressions for the WP-16 adversarial review of `@celld/mcp`: each test
 * is named by its `DB-REV-MCP` identifier and failed on the code before
 * the fix.
 *
 * @module
 */

import { assert, assertEquals } from "@celld/core/assert";
import {
  type FetchLike,
  IDEMPOTENCY_CAPABILITY,
  IDEMPOTENCY_KEY,
  type IdempotencyStore,
  type JSONRPCNotification,
  type JSONRPCRequest,
  type JSONRPCResponse,
  McpClient,
  McpError,
  mcpHttpHandler,
  McpServer,
  MemoryChangeSource,
  META,
  paramsDigest,
  type Transport,
  unsafeMemoryIdempotencyStore,
} from "@celld/mcp";
import {
  handlerFetch,
  inProcessTransport,
  testPrincipal,
} from "@celld/mcp/testing";
import { AuthError, errorParams } from "@celld/web/router";
import {
  CLIENT_INFO,
  demoServer,
  errorOf,
  request,
  resultOf,
  SECRET,
  SERVER_INFO,
} from "./fixture.ts";

async function failure(promise: Promise<unknown>): Promise<McpError> {
  try {
    await promise;
  } catch (error) {
    assert(error instanceof McpError, `not an McpError: ${error}`);
    return error;
  }
  throw new Error("resolved");
}

Deno.test("DB-REV-MCP-1: a handler's unauthorized McpError is no step-up and no re-send", async () => {
  const server = new McpServer({ info: SERVER_INFO });
  let effects = 0;
  const upstream = "upstream-secret-detail refused the credentials (401)";
  server.tool({
    name: "deploy",
    run: () => {
      effects++;
      // A gateway's inner McpClient call refused after the local write.
      throw new McpError("unauthorized", upstream, { status: 401 });
    },
  });
  server.prompt({
    name: "brief",
    get: () => {
      throw new McpError("unauthorized", upstream, { status: 403 });
    },
  });
  const handler = mcpHttpHandler(server, {
    auth: {
      name: "platform",
      ambient: false,
      authenticate: (c) =>
        c.req.headers.get("x-t") === "ok"
          ? { subject: "alice" }
          : new AuthError("invalid_token", ""),
      challenge: (e) => ({ scheme: "Bearer", params: errorParams(e) }),
    },
  });
  const statuses: number[] = [];
  const bodies: string[] = [];
  const challenges: string[] = [];
  const client = McpClient.http("https://mcp.test/mcp", {
    info: CLIENT_INFO,
    fetch: async (input, init) => {
      const response = await handlerFetch(handler)(input, init);
      statuses.push(response.status);
      bodies.push(await response.clone().text());
      return response;
    },
    auth: {
      headers: () => ({ "x-t": "ok" }),
      // What OAuthSession.challenge does on 403 insufficient_scope.
      challenge: (challenge) => {
        challenges.push(challenge.headers.get("www-authenticate") ?? "");
        return Promise.resolve(challenge.attempt === 1);
      },
    },
  });
  await client.listTools();
  const result = await client.callTool("deploy", {});
  assertEquals(effects, 1);
  assertEquals(result.isError, true);
  assertEquals(result.content, [{ type: "text", text: "Tool deploy failed" }]);
  assertEquals(challenges, []);
  assert(
    statuses.every((status) => status !== 401 && status !== 403),
    `no auth failure: ${statuses}`,
  );
  assert(
    bodies.every((body) => !body.includes("upstream-secret-detail")),
    "the upstream text stays inside the server",
  );

  const error = await failure(client.getPrompt("brief"));
  assertEquals([error.kind, error.code], ["rpc", -32603]);
  assertEquals(challenges, []);
  assert(
    bodies.every((body) => !body.includes("upstream-secret-detail")),
    "the upstream text stays inside the server",
  );
});

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

Deno.test("DB-REV-MCP-2: a timed-out or 504 non-idempotent call is not retryable", async () => {
  const server = new McpServer({ info: SERVER_INFO });
  const effects = { charge: 0, lookup: 0 };
  server.tool({
    name: "charge",
    run: async () => {
      effects.charge++;
      await sleep(150);
      return "charged";
    },
  });
  server.tool({
    name: "lookup",
    annotations: { idempotentHint: true },
    run: async () => {
      effects.lookup++;
      await sleep(150);
      return "found";
    },
  });

  const direct = new McpClient({
    transport: inProcessTransport(server),
    info: CLIENT_INFO,
    timeoutMs: 30,
  });
  const timedOut = await failure(direct.callTool("charge"));
  assertEquals([timedOut.kind, timedOut.retryable], ["timeout", false]);
  assert(
    timedOut.message.includes("may have executed"),
    `says it may have run: ${timedOut.message}`,
  );

  const routed = McpClient.http("https://mcp.test/mcp", {
    info: CLIENT_INFO,
    fetch: handlerFetch(
      mcpHttpHandler(server, { public: true, timeout: "PT0.03S" }),
    ),
  });
  const gateway = await failure(routed.callTool("charge"));
  assertEquals([gateway.kind, gateway.status, gateway.retryable], [
    "http",
    504,
    false,
  ]);
  assert(
    gateway.message.includes("may have executed"),
    `says it may have run: ${gateway.message}`,
  );

  // A read that times out may be sent again.
  await direct.listTools();
  const read = await failure(direct.callTool("lookup"));
  assertEquals([read.kind, read.retryable], ["timeout", true]);
  await sleep(200);
  assertEquals(effects.charge, 2);
});

/** Answers through `server`, breaking the first `breaks` tools/call bodies. */
function breakingFetch(server: McpServer, breaks: number) {
  const seen: JSONRPCRequest[] = [];
  let broken = 0;
  const fetch: FetchLike = async (_input, init) => {
    const message = JSON.parse(String(init?.body)) as JSONRPCRequest;
    seen.push(message);
    const response = await server.handle(message, {});
    if (message.method === "tools/call" && broken < breaks) {
      broken++;
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(": working\n\n"));
          controller.error(new Error("connection reset"));
        },
      });
      return new Response(body, {
        headers: { "content-type": "text/event-stream" },
      });
    }
    return Response.json(response);
  };
  return { fetch, seen };
}

/** A stand-in for a store every instance shares (one isolate here). */
function sharedStore(): IdempotencyStore {
  return { ...unsafeMemoryIdempotencyStore(), durable: true };
}

Deno.test("DB-REV-MCP-3: a key is retried only against a server advertising durable deduplication", async () => {
  const cases = [
    { name: "no store", idempotency: undefined, retried: false },
    {
      name: "per-isolate store",
      idempotency: { store: unsafeMemoryIdempotencyStore() },
      retried: false,
    },
    {
      name: "durable store",
      idempotency: { store: sharedStore() },
      retried: true,
    },
  ];
  for (const { name, idempotency, retried } of cases) {
    const server = new McpServer({ info: SERVER_INFO, idempotency });
    let effects = 0;
    server.tool({
      name: "charge",
      run: () => {
        effects++;
        return "charged";
      },
    });
    const { fetch, seen } = breakingFetch(server, 1);
    const client = McpClient.http("https://mcp.test/", {
      info: CLIENT_INFO,
      fetch,
    });
    const call = client.callTool("charge", {}, {
      idempotencyKey: crypto.randomUUID(),
    });
    if (retried) {
      assertEquals((await call).content, [{ type: "text", text: "charged" }]);
    } else {
      const error = await failure(call);
      assertEquals([error.kind, error.retryable], ["stream", false], name);
    }
    assertEquals(effects, 1, name);
    assertEquals(
      seen.filter((message) => message.method === "tools/call").length,
      retried ? 2 : 1,
      name,
    );
  }
});

Deno.test("DB-REV-MCP-3: server/discover advertises deduplication and whether it is durable", async () => {
  const advertised = async (server: McpServer) => {
    const client = McpClient.http("https://mcp.test/", {
      info: CLIENT_INFO,
      fetch: breakingFetch(server, 0).fetch,
    });
    return (await client.discover()).capabilities.experimental
      ?.[IDEMPOTENCY_CAPABILITY];
  };
  assertEquals(
    await advertised(new McpServer({ info: SERVER_INFO })),
    undefined,
  );
  assertEquals(
    await advertised(
      new McpServer({
        info: SERVER_INFO,
        idempotency: { store: unsafeMemoryIdempotencyStore() },
      }),
    ),
    { durable: false },
  );
  assertEquals(
    await advertised(
      new McpServer({
        info: SERVER_INFO,
        idempotency: { store: sharedStore() },
      }),
    ),
    { durable: true },
  );
  assertEquals(IDEMPOTENCY_KEY, "celld/idempotency-key");
});

/** A `charge` tool that does its effect, then waits `ms` or its abort. */
function chargingServer(ms: number) {
  const server = new McpServer({
    info: SERVER_INFO,
    idempotency: { store: sharedStore() },
    onError: () => {},
  });
  const effects = { charge: 0 };
  server.tool({
    name: "charge",
    run: async (_args, ctx) => {
      effects.charge++;
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, ms);
        ctx.signal.addEventListener("abort", () => {
          clearTimeout(timer);
          reject(ctx.signal.reason);
        }, { once: true });
      });
      return "charged";
    },
  });
  return { server, effects };
}

Deno.test("DB-REV-MCP-4: a keyed call whose client left still records the real answer", async () => {
  const { server, effects } = chargingServer(60);
  const alice = testPrincipal("alice");
  const keyed = () =>
    request("tools/call", { name: "charge" }, {
      meta: { [IDEMPOTENCY_KEY]: "k-1" },
    });
  const gone = new AbortController();
  const first = server.handle(keyed(), {
    principal: alice,
    signal: gone.signal,
  });
  await sleep(10);
  gone.abort(new Error("client gone"));
  assertEquals(await first, null);
  // At once: still running, not a stored "Internal error".
  const busy = errorOf(await server.handle(keyed(), { principal: alice }));
  assertEquals(busy.data, { idempotencyKey: "k-1", inProgress: true });
  await sleep(100);
  const answer = resultOf(await server.handle(keyed(), { principal: alice }));
  assertEquals(answer.content, [{ type: "text", text: "charged" }]);
  assertEquals(effects.charge, 1);
});

Deno.test("DB-REV-MCP-4: the client waits out inProgress under the same key", async () => {
  const { server, effects } = chargingServer(80);
  const seen: JSONRPCRequest[] = [];
  let broke = false;
  const fetch: FetchLike = async (_input, init) => {
    const message = JSON.parse(String(init?.body)) as JSONRPCRequest;
    seen.push(message);
    if (message.method === "tools/call" && !broke) {
      // The connection drops mid-call: the server sees its client leave.
      broke = true;
      const gone = new AbortController();
      const running = server.handle(message, { signal: gone.signal });
      await sleep(10);
      gone.abort(new Error("connection reset"));
      await running;
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(": working\n\n"));
          controller.error(new Error("connection reset"));
        },
      });
      return new Response(body, {
        headers: { "content-type": "text/event-stream" },
      });
    }
    return Response.json(await server.handle(message, {}));
  };
  const client = McpClient.http("https://mcp.test/", {
    info: CLIENT_INFO,
    fetch,
  });
  const result = await client.callTool("charge", {}, {
    idempotencyKey: "k-2",
  });
  assertEquals(result.content, [{ type: "text", text: "charged" }]);
  assertEquals(effects.charge, 1);
  const calls = seen.filter((message) => message.method === "tools/call");
  assert(calls.length >= 3, `polled while in progress: ${calls.length}`);
});

Deno.test("DB-REV-MCP-6: abandoned handlers are capped, and unkeyed ones are not held", async () => {
  const server = new McpServer({
    info: SERVER_INFO,
    maxAbandonedRequests: 2,
    onError: () => {},
  });
  let running = 0;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  server.tool({
    name: "stubborn",
    run: async () => {
      running++;
      await gate; // ignores its signal
      running--;
      return "done";
    },
  });
  const held: Promise<unknown>[] = [];
  for (let i = 0; i < 5; i++) {
    const gone = new AbortController();
    const response = server.handle(
      request("tools/call", { name: "stubborn" }),
      { signal: gone.signal, waitUntil: (promise) => held.push(promise) },
    );
    await sleep(0);
    gone.abort();
    await response;
  }
  assertEquals(running, 2);
  assertEquals(held.length, 0);
  const refused = errorOf(
    await server.handle(request("tools/call", { name: "stubborn" }), {}),
  );
  assertEquals(refused.code, -32603);
  assertEquals(refused.data, { busy: true });
  release();
  await sleep(0);
  assertEquals(running, 0);
  const again = server.handle(request("tools/call", { name: "stubborn" }), {});
  assertEquals(resultOf(await again).content, [{
    type: "text",
    text: "done",
  }]);
});

Deno.test("DB-REV-MCP-8: an anonymous keyed input_required answer is never replayed", async () => {
  const server = demoServer({ idempotency: { store: sharedStore() } });
  const round1 = () =>
    request("tools/call", { name: "login" }, {
      meta: { [IDEMPOTENCY_KEY]: "anon-key" },
      capabilities: { elicitation: { form: {} } },
    });
  const first = resultOf(await server.handle(round1(), {}));
  assertEquals(first.resultType, "input_required");
  assert(typeof first.requestState === "string", "the first gets its state");
  const replay = await server.handle(round1(), {});
  assert(
    !JSON.stringify(replay).includes(first.requestState as string),
    "no replay of the sealed state",
  );
  assertEquals(errorOf(replay).code, -32600);
  // A caller with credentials still gets its own replay.
  const alice = testPrincipal("alice");
  const own = resultOf(await server.handle(round1(), { principal: alice }));
  const ownAgain = resultOf(
    await server.handle(round1(), { principal: alice }),
  );
  assertEquals(ownAgain.requestState, own.requestState);
});

/** A transport that runs `message` on `inner`, then loses its answer. */
function lost(message: JSONRPCRequest): McpError {
  return new McpError("stream", `the answer to ${message.method} broke off`, {
    method: message.method,
    accepted: true,
  });
}

Deno.test("DB-REV-MCP-7: a read round carrying elicitation answers is not sent again", async () => {
  const server = new McpServer({ info: SERVER_INFO, stateSecret: SECRET });
  let approvals = 0;
  server.resource({
    uri: "config://approve",
    name: "approve",
    read: (ctx) => {
      const answer = ctx.elicit("ok", {
        mode: "form",
        message: "Approve?",
        requestedSchema: { type: "object", properties: {} },
      });
      if (answer.action === "accept") approvals++;
      return "approved";
    },
  });
  const inner = inProcessTransport(server);
  const answered: string[] = [];
  const transport: Transport = {
    async request(message, options) {
      const response = await inner.request(message, options);
      if (message.params?.inputResponses !== undefined) {
        answered.push(message.method);
        throw lost(message);
      }
      return response;
    },
  };
  const client = new McpClient({
    transport,
    info: CLIENT_INFO,
    handlers: { elicitation: () => ({ action: "accept", content: {} }) },
  });
  const error = await failure(client.readResource("config://approve"));
  assertEquals([error.kind, error.retryable], ["stream", false]);
  assertEquals(answered, ["resources/read"]);
  assertEquals(approvals, 1);
});

Deno.test("DB-REV-MCP-9: tools/list_changed drops the cached idempotentHint", async () => {
  const server = new McpServer({ info: SERVER_INFO });
  let lookups = 0;
  server.tool({
    name: "lookup",
    annotations: { idempotentHint: true },
    run: () => {
      lookups++;
      return "found";
    },
  });
  const inner = inProcessTransport(server);
  let changed!: () => void;
  const change = new Promise<void>((resolve) => changed = resolve);
  let delivered!: () => void;
  const arrived = new Promise<void>((resolve) => delivered = resolve);
  const transport: Transport = {
    async request(message, options) {
      if (message.method === "subscriptions/listen") {
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
        delivered();
        return await new Promise<JSONRPCResponse>((resolve) =>
          options.signal.addEventListener("abort", () =>
            resolve({
              jsonrpc: "2.0",
              id: message.id,
              result: {},
            } as JSONRPCResponse))
        );
      }
      const response = await inner.request(message, options);
      if (message.method === "tools/call") throw lost(message);
      return response;
    },
  };
  // No result cache: the hint lives in the client's tool map alone.
  const client = new McpClient({ transport, info: CLIENT_INFO });
  const subscription = client.listen({ toolsListChanged: true });
  await subscription.acknowledged;
  await client.listTools();
  changed();
  await arrived;
  const error = await failure(client.callTool("lookup"));
  subscription.close();
  assertEquals([error.kind, error.retryable], ["stream", false]);
  assertEquals(lookups, 1);
});

Deno.test("DB-REV-MCP-5: the listen URI filter is bounded in total and cheap", async () => {
  const server = new McpServer({
    info: SERVER_INFO,
    changes: new MemoryChangeSource(),
  });
  for (let i = 0; i < 20; i++) {
    server.resourceTemplate({
      uriTemplate: `app://t${i}/{a}/{b}/x/{c}/{+rest}`,
      name: `t${i}`,
      visible: () => true,
      read: () => "x",
    });
  }
  const listen = async (uris: string[]) => {
    const acknowledged: unknown[] = [];
    const leave = new AbortController();
    const started = performance.now();
    const open = server.handle(
      request("subscriptions/listen", {
        notifications: { resourceSubscriptions: uris },
      }),
      {
        signal: leave.signal,
        emit: (notification) => {
          if (
            notification.method === "notifications/subscriptions/acknowledged"
          ) {
            acknowledged.push(notification.params?.notifications);
            leave.abort();
          }
        },
      },
    );
    const response = await open;
    return { response, acknowledged, elapsed: performance.now() - started };
  };
  const long = (n: number) => "app://t19/" + `${n}`.padEnd(8 * 1024 - 20, "a");
  // 1000 URIs of 8 KiB: refused for their total, before any matching.
  const big = await listen(Array.from({ length: 1000 }, (_, n) => long(n)));
  assertEquals(errorOf(big.response).code, -32602);
  assert(big.elapsed < 50, `refused in ${big.elapsed} ms`);
  // Under the total: matched, fast, since a template's leading literal
  // rules most of them out at once.
  const small = await listen(Array.from({ length: 7 }, (_, n) => long(n)));
  assertEquals(
    (small.acknowledged[0] as { resourceSubscriptions: string[] })
      .resourceSubscriptions.length,
    7,
  );
  assert(small.elapsed < 100, `matched in ${small.elapsed} ms`);
});

Deno.test("DB-REV-MCP-10: sealed state opens only on the server that sealed it", async () => {
  const login = (params: Record<string, unknown> = {}) =>
    request("tools/call", { name: "login", ...params }, {
      capabilities: { elicitation: { form: {} } },
    });
  const alice = testPrincipal("alice");
  // One secret shared by two different servers.
  const staging = demoServer({ info: { name: "staging", version: "1" } });
  const prod = demoServer({ info: { name: "prod", version: "1" } });
  const first = resultOf(await staging.handle(login(), { principal: alice }));
  const answer = {
    inputResponses: { github: { action: "accept", content: { login: "x" } } },
    requestState: first.requestState,
  };
  assertEquals(
    errorOf(await prod.handle(login(answer), { principal: alice })),
    { code: -32602, message: "Invalid requestState" },
  );
  // Same name, told apart by an explicit audience.
  const east = demoServer({ stateAudience: "https://east.example/mcp" });
  const west = demoServer({ stateAudience: "https://west.example/mcp" });
  const sealed = resultOf(await east.handle(login(), { principal: alice }));
  assertEquals(
    errorOf(
      await west.handle(
        login({ ...answer, requestState: sealed.requestState }),
        { principal: alice },
      ),
    ).code,
    -32602,
  );
  // The sealing server still opens it.
  const done = resultOf(
    await staging.handle(login(answer), { principal: alice }),
  );
  assertEquals(done.content, [{ type: "text", text: "hello x" }]);
});

/**
 * Runs `body` with the `Object.prototype.__proto__` accessor workerd has
 * (Deno removes it), so `copy["__proto__"] = x` sets a prototype.
 */
function withProtoAccessor<T>(body: () => T): T {
  const had = Object.getOwnPropertyDescriptor(Object.prototype, "__proto__");
  Object.defineProperty(Object.prototype, "__proto__", {
    configurable: true,
    get() {
      return Object.getPrototypeOf(this);
    },
    set(value) {
      if (typeof value === "object") Object.setPrototypeOf(this, value);
    },
  });
  try {
    return body();
  } finally {
    if (had === undefined) {
      delete (Object.prototype as Record<string, unknown>).__proto__;
    } else Object.defineProperty(Object.prototype, "__proto__", had);
  }
}

Deno.test("DB-REV-MCP-11: an own __proto__ key is copied as data, not as a prototype", async () => {
  const input = JSON.parse(
    '{"type":"object","properties":{"__proto__":{"type":"string","maxLength":3},"n":{"type":"number"}},"additionalProperties":false}',
  );
  const server = withProtoAccessor(() => {
    const server = new McpServer({
      info: SERVER_INFO,
      cache: JSON.parse('{"__proto__":{"scope":"public"}}'),
    });
    server.tool({ name: "t", input, run: (args) => JSON.stringify(args) });
    return server;
  });
  const listed = resultOf(await server.handle(request("tools/list"), {}));
  const schema = (listed.tools as { inputSchema: Record<string, unknown> }[])[0]
    .inputSchema;
  const properties = schema.properties as Record<string, unknown>;
  assert(Object.hasOwn(properties, "__proto__"), "the key is kept");
  assertEquals(Object.getPrototypeOf(properties), Object.prototype);
  // The options' cache hints did not inherit `scope: "public"`.
  const discovered = resultOf(
    await server.handle(request("server/discover"), {}),
  );
  assertEquals(discovered.cacheScope, "private");
  // A peer's own `__proto__` param is part of the request's digest.
  const params = JSON.parse('{"name":"t","__proto__":{"x":1}}');
  const [withKey, without] = withProtoAccessor(() => [
    paramsDigest("tools/call", params),
    paramsDigest("tools/call", { name: "t" }),
  ]);
  assert(await withKey !== await without, "the __proto__ key is digested");
});

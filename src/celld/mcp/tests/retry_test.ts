// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * When the client sends a request again. The fake server runs each request
 * for real (so a tool's side effect is recorded), then breaks the response
 * body after the headers, as a connection reset mid-answer does: the server
 * has executed the request, the client never sees the answer.
 */

import { assert, assertEquals } from "@celld/core/assert";
import {
  type FetchLike,
  IDEMPOTENCY_KEY,
  type JSONRPCRequest,
  McpClient,
  McpError,
  McpServer,
  unsafeMemoryIdempotencyStore,
} from "@celld/mcp";
import { testPrincipal } from "@celld/mcp/testing";
import { CLIENT_INFO, request, SERVER_INFO } from "./fixture.ts";

/** Answers through `server`, breaking the first `breaks` bodies. */
function breakingFetch(server: McpServer, breaks: number) {
  const seen: JSONRPCRequest[] = [];
  const fetch: FetchLike = async (_input, init) => {
    const message = JSON.parse(String(init?.body)) as JSONRPCRequest;
    seen.push(message);
    const response = await server.handle(message, {});
    if (seen.length <= breaks) {
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

/** A server whose `charge` tool counts its executions. */
function ledger() {
  const server = new McpServer({ info: SERVER_INFO });
  const effects = { charge: 0, lookup: 0 };
  server.tool({
    name: "charge",
    run: () => {
      effects.charge++;
      return "charged";
    },
  });
  server.tool({
    name: "lookup",
    annotations: { idempotentHint: true },
    run: () => {
      effects.lookup++;
      return "found";
    },
  });
  return { server, effects };
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

Deno.test("a tools/call whose body broke after execution is not sent again", async () => {
  const { server, effects } = ledger();
  const { fetch, seen } = breakingFetch(server, 1);
  const client = McpClient.http("https://mcp.test/", {
    info: CLIENT_INFO,
    fetch,
  });
  const error = await failure(client.callTool("charge"));
  assertEquals(effects.charge, 1);
  assertEquals(seen.length, 1);
  assertEquals(error.kind, "stream");
  assertEquals(error.retryable, false);
});

Deno.test("a read is sent again after its body broke", async () => {
  const { server } = ledger();
  const { fetch, seen } = breakingFetch(server, 1);
  const client = McpClient.http("https://mcp.test/", {
    info: CLIENT_INFO,
    fetch,
  });
  const tools = await client.listTools();
  assertEquals(tools.tools.map((tool) => tool.name), ["charge", "lookup"]);
  assertEquals(seen.map((message) => message.method), [
    "tools/list",
    "tools/list",
  ]);
  assert(seen[0].id !== seen[1].id, "each attempt has its own id");
});

Deno.test("retry.max bounds the attempts, and 0 disables retrying", async () => {
  const { server } = ledger();
  const three = breakingFetch(server, 3);
  const client = McpClient.http("https://mcp.test/", {
    info: CLIENT_INFO,
    fetch: three.fetch,
    retry: { max: 3 },
  });
  await client.listTools();
  assertEquals(three.seen.length, 4);

  const none = breakingFetch(server, 1);
  const strict = McpClient.http("https://mcp.test/", {
    info: CLIENT_INFO,
    fetch: none.fetch,
    retry: { max: 0 },
  });
  const error = await failure(strict.listTools());
  assertEquals([error.kind, error.retryable, error.accepted], [
    "stream",
    true,
    true,
  ]);
  assertEquals(none.seen.length, 1);

  for (const max of [-1, 1.5, Number.NaN, 11]) {
    let thrown: unknown = null;
    try {
      McpClient.http("https://mcp.test/", {
        info: CLIENT_INFO,
        retry: { max },
      });
    } catch (error) {
      thrown = error;
    }
    assert(thrown instanceof RangeError, `retry.max ${max} accepted`);
  }
});

Deno.test("a tool advertising idempotentHint is retried once its definition is known", async () => {
  const { server, effects } = ledger();
  const unknown = breakingFetch(server, 1);
  const cold = McpClient.http("https://mcp.test/", {
    info: CLIENT_INFO,
    fetch: unknown.fetch,
  });
  // Without tools/list the client cannot know the hint: no retry.
  assertEquals((await failure(cold.callTool("lookup"))).retryable, false);
  assertEquals(effects.lookup, 1);

  const known = breakingFetch(server, 0);
  const broken = breakingFetch(server, 1);
  const warm = McpClient.http("https://mcp.test/", {
    info: CLIENT_INFO,
    fetch: async (input, init) => {
      const body = JSON.parse(String(init?.body));
      return body.method === "tools/list"
        ? await known.fetch(input, init)
        : await broken.fetch(input, init);
    },
  });
  await warm.listTools();
  const result = await warm.callTool("lookup");
  assertEquals(result.content, [{ type: "text", text: "found" }]);
  assertEquals(broken.seen.length, 2);
  assertEquals(effects.lookup, 3);
  // The same client still refuses to repeat the tool without the hint.
  const charge = breakingFetch(server, 1);
  const mixed = McpClient.http("https://mcp.test/", {
    info: CLIENT_INFO,
    fetch: async (input, init) => {
      const body = JSON.parse(String(init?.body));
      return body.method === "tools/list"
        ? await known.fetch(input, init)
        : await charge.fetch(input, init);
    },
  });
  await mixed.listTools();
  const error = await failure(mixed.callTool("charge"));
  assertEquals(charge.seen.length, 1);
  assertEquals(effects.charge, 1);
  assertEquals(error.retryable, false);
  assert(
    error.message.includes("may have executed"),
    `message: ${error.message}`,
  );
});

Deno.test("task and other mutations are not sent again", async () => {
  const { server } = ledger();
  const { fetch, seen } = breakingFetch(server, 1);
  const client = McpClient.http("https://mcp.test/", {
    info: CLIENT_INFO,
    fetch,
    tasks: true,
  });
  await failure(client.task("t-1").cancel());
  await failure(client.request("tasks/update", {
    taskId: "t-1",
    inputResponses: {},
  }));
  await failure(client.request("vendor/write", {}));
  assertEquals(seen.map((message) => message.method), [
    "tasks/cancel",
    "tasks/update",
    "vendor/write",
  ]);
});

Deno.test("a caller's retry.idempotent decides, given the default", async () => {
  const { server, effects } = ledger();
  const decided: [string, boolean][] = [];
  const { fetch, seen } = breakingFetch(server, 2);
  const client = McpClient.http("https://mcp.test/", {
    info: CLIENT_INFO,
    fetch,
    retry: {
      idempotent: (method, _params, byDefault) => {
        decided.push([method, byDefault]);
        return method === "tools/call";
      },
    },
  });
  await failure(client.listTools());
  const result = await client.callTool("charge");
  assertEquals(result.content, [{ type: "text", text: "charged" }]);
  assertEquals(effects.charge, 2);
  assertEquals(seen.length, 3);
  assertEquals(decided, [["tools/list", true], ["tools/call", false]]);
});

Deno.test("a connection failure is retried for reads only", async () => {
  const { server, effects } = ledger();
  let calls = 0;
  const fetch: FetchLike = async (_input, init) => {
    calls++;
    const message = JSON.parse(String(init?.body)) as JSONRPCRequest;
    // The server got the request; the connection dropped before the answer.
    const response = await server.handle(message, {});
    if (calls % 2 === 1) throw new TypeError("connection reset");
    return Response.json(response);
  };
  const client = McpClient.http("https://mcp.test/", {
    info: CLIENT_INFO,
    fetch,
  });
  await client.listTools();
  assertEquals(calls, 2);
  const error = await failure(client.callTool("charge"));
  assertEquals([error.kind, error.retryable], ["connection", false]);
  assertEquals(effects.charge, 1);
  assertEquals(calls, 3);
});

Deno.test("an idempotency key makes a tools/call retry safe with a server store", async () => {
  // One isolate stands in for a store every instance shares: a server
  // advertises `durable` from its store, and only then is a key retried.
  const store = { ...unsafeMemoryIdempotencyStore(), durable: true };
  const server = new McpServer({ info: SERVER_INFO, idempotency: { store } });
  let charges = 0;
  server.tool({
    name: "charge",
    input: { type: "object", properties: { cents: { type: "integer" } } },
    run: (args) => {
      charges++;
      return `charged ${(args as { cents: number }).cents}`;
    },
  });
  const { fetch, seen } = breakingFetch(server, 1);
  const client = McpClient.http("https://mcp.test/", {
    info: CLIENT_INFO,
    fetch,
  });
  const result = await client.callTool("charge", { cents: 5 }, {
    idempotencyKey: "order-17",
  });
  assertEquals(result.content, [{ type: "text", text: "charged 5" }]);
  assertEquals(charges, 1);
  // The client asked server/discover whether the server deduplicates.
  assertEquals(seen.map((message) => message.method), [
    "tools/call",
    "server/discover",
    "tools/call",
  ]);
  assertEquals(
    seen.filter((message) => message.method === "tools/call").map((
      message,
    ) => message.params?._meta?.[IDEMPOTENCY_KEY]),
    ["order-17", "order-17"],
  );
  // A later duplicate gets the stored answer; a new key runs again.
  const again = await client.callTool("charge", { cents: 5 }, {
    idempotencyKey: "order-17",
  });
  assertEquals(again.content, result.content);
  assertEquals(charges, 1);
  await client.callTool("charge", { cents: 5 }, { idempotencyKey: "order-18" });
  assertEquals(charges, 2);
  // The key with other arguments is refused, not answered with the old result.
  const reused = await failure(
    client.callTool("charge", { cents: 9 }, { idempotencyKey: "order-17" }),
  );
  assertEquals(reused.code, -32602);
  assertEquals(charges, 2);
  // Keys must be printable and short.
  for (const key of ["", "a b", "x".repeat(256)]) {
    assertEquals(
      (await failure(
        client.callTool("charge", { cents: 1 }, { idempotencyKey: key }),
      )).kind,
      "invalid_request",
    );
  }
  assertEquals(charges, 2);
});

Deno.test("the server keys idempotency by principal and tool", async () => {
  const store = unsafeMemoryIdempotencyStore();
  const server = new McpServer({ info: SERVER_INFO, idempotency: { store } });
  const runs: string[] = [];
  for (const name of ["a", "b"]) {
    server.tool({
      name,
      run: (_args, ctx) => {
        runs.push(`${name}:${ctx.principal?.subject ?? "-"}`);
        return name;
      },
    });
  }
  const call = (name: string, subject: string | null) =>
    server.handle(
      request("tools/call", { name }, { meta: { [IDEMPOTENCY_KEY]: "k" } }),
      { principal: subject === null ? null : testPrincipal(subject) },
    );
  await call("a", "alice");
  await call("a", "alice");
  await call("a", "bob");
  await call("b", "alice");
  await call("a", null);
  await call("a", null);
  assertEquals(runs, ["a:alice", "a:bob", "b:alice", "a:-"]);
});

Deno.test("a duplicate of a request still running is refused, and a failure is kept", async () => {
  const store = unsafeMemoryIdempotencyStore();
  const server = new McpServer({
    info: SERVER_INFO,
    idempotency: { store },
    onError: () => {},
  });
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const started = Promise.withResolvers<void>();
  let runs = 0;
  server.tool({
    name: "slow",
    run: async () => {
      runs++;
      started.resolve();
      await gate;
      throw McpError.invalidParams("no such account");
    },
  });
  const message = () =>
    request("tools/call", { name: "slow" }, {
      meta: { [IDEMPOTENCY_KEY]: "k" },
    });
  const first = server.handle(message(), {});
  await started.promise;
  const busy = await server.handle(message(), {});
  assert(busy !== null && "error" in busy, "the duplicate is an error");
  assertEquals(busy.error.data, { idempotencyKey: "k", inProgress: true });
  release();
  const done = await first;
  assert(done !== null && "error" in done, "the first call failed");
  const later = await server.handle(message(), {});
  assert(later !== null && "error" in later, "the duplicate failed");
  assertEquals(later.error, done.error);
  assertEquals(runs, 1);
});

Deno.test("a completion counts only under the token of the claim holding the key", async () => {
  let now = 0;
  const store = unsafeMemoryIdempotencyStore({ now: () => now });
  const first = await store.claim("key", 10);
  assert(first.first, "the key was free");
  now = 11;
  const second = await store.claim("key", 10);
  assert(second.first, "the expired claim was claimed again");
  assert(second.token !== first.token, "each claim has its own token");
  // The first execution completes after the second claimed the slot.
  await store.complete("key", first.token, { execution: 1 });
  assertEquals(await store.claim("key", 10), { first: false });
  await store.complete("key", second.token, { execution: 2 });
  assertEquals(await store.claim("key", 10), {
    first: false,
    result: { execution: 2 },
  });
});

Deno.test("an execution that outlived its claim does not complete the claim that replaced it", async () => {
  let now = 0;
  const store = unsafeMemoryIdempotencyStore({ now: () => now });
  const server = new McpServer({
    info: SERVER_INFO,
    idempotency: { store, ttlMs: 10 },
  });
  const started = [
    Promise.withResolvers<void>(),
    Promise.withResolvers<void>(),
  ];
  const gates = [Promise.withResolvers<void>(), Promise.withResolvers<void>()];
  let runs = 0;
  server.tool({
    name: "slow",
    run: async () => {
      const run = ++runs;
      started[run - 1].resolve();
      await gates[run - 1].promise;
      return `run ${run}`;
    },
  });
  const message = () =>
    request("tools/call", { name: "slow" }, {
      meta: { [IDEMPOTENCY_KEY]: "k" },
    });
  const first = server.handle(message(), {});
  await started[0].promise;
  // The first execution outlives its claim; a retry claims the slot again
  // and runs, and then the first one finishes.
  now = 11;
  const second = server.handle(message(), {});
  await started[1].promise;
  assertEquals(runs, 2);
  gates[0].resolve();
  await first;
  const busy = await server.handle(message(), {});
  assert(busy !== null && "error" in busy, "the second is still running");
  assertEquals(busy.error.data, { idempotencyKey: "k", inProgress: true });
  gates[1].resolve();
  const done = await second;
  assert(done !== null && "result" in done, "the second call answered");
  const later = await server.handle(message(), {});
  assert(later !== null && "result" in later, "the duplicate is answered");
  assertEquals(later.result, done.result);
  assertEquals(
    (later.result as unknown as { content: unknown }).content,
    [{ type: "text", text: "run 2" }],
  );
  assertEquals(runs, 2);
});

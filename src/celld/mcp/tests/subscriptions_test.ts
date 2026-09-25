// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

import { assert, assertEquals } from "@celld/assert";
import {
  type ChangeBatch,
  type ChangeEvent,
  type ChangeHubApi,
  ChangeLog,
  durableChangeSource,
  expand,
  type JSONRPCNotification,
  McpClient,
  mcpHttpHandler,
  memoryCache,
  MemoryChangeSource,
  META,
  pollingChangeSource,
  type ServerNotification,
} from "@celld/mcp";
import { McpChangeHub } from "@celld/mcp/durable";
import { handlerFetch, inProcessTransport } from "@celld/mcp/testing";
import { CLIENT_INFO, demoServer, request, resultOf } from "./fixture.ts";

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

async function until(condition: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`timed out waiting for ${what}`);
}

Deno.test("the change log numbers events and long-polls", async () => {
  const log = new ChangeLog({ epoch: "e1", capacity: 3 });
  assertEquals(log.since(null), {
    epoch: "e1",
    seq: 0,
    events: [],
    reset: false,
  });
  log.append({ type: "tools" });
  log.append({ type: "resource", uri: "a://1" });
  assertEquals(log.since({ epoch: "e1", seq: 1 }), {
    epoch: "e1",
    seq: 2,
    events: [{ type: "resource", uri: "a://1" }],
    reset: false,
  });
  // Another epoch, a cursor from the future, or one overrun: reset.
  assertEquals(log.since({ epoch: "e0", seq: 1 }).reset, true);
  assertEquals(log.since({ epoch: "e1", seq: 9 }).reset, true);
  log.append({ type: "prompts" });
  log.append({ type: "prompts" });
  log.append({ type: "prompts" });
  assertEquals(log.since({ epoch: "e1", seq: 1 }).reset, true);
  assertEquals(log.since({ epoch: "e1", seq: 2 }).events.length, 3);

  const waiting = log.wait({ epoch: "e1", seq: log.head }, 5000);
  await tick();
  assertEquals(log.waiting, 1);
  log.append({ type: "tools" });
  assertEquals((await waiting).events, [{ type: "tools" }]);
  const empty = await log.wait({ epoch: "e1", seq: log.head }, 5);
  assertEquals([empty.events, empty.reset], [[], false]);
  assertEquals(log.waiting, 0);
});

Deno.test("the memory source delivers what is published after listen", async () => {
  const source = new MemoryChangeSource();
  const stop = new AbortController();
  const events = await source.listen(stop.signal);
  assertEquals(source.listeners, 1);
  // Published before the first next(): still delivered.
  source.publish({ type: "tools" });
  const iterator = events[Symbol.asyncIterator]();
  assertEquals(await iterator.next(), {
    done: false,
    value: { type: "tools" },
  });
  const pending = iterator.next();
  source.publish({ type: "resource", uri: "x" });
  assertEquals(await pending, {
    done: false,
    value: { type: "resource", uri: "x" },
  });
  stop.abort();
  assertEquals((await iterator.next()).done, true);
  assertEquals(source.listeners, 0);
});

Deno.test("the polling source follows a log, resets and survives errors", async () => {
  let log = new ChangeLog({ epoch: "a" });
  let failNext = false;
  const errors: unknown[] = [];
  const source = pollingChangeSource(async (cursor, waitMs) => {
    if (failNext) {
      failNext = false;
      throw new Error("hub unreachable");
    }
    return await log.wait(cursor, Math.min(waitMs, 20));
  }, { waitMs: 20, errorDelayMs: 1, onError: (error) => errors.push(error) });
  const stop = new AbortController();
  log.append({ type: "tools" }); // Before listen: not delivered.
  const iterator = (await source.listen(stop.signal))[Symbol.asyncIterator]();
  log.append({ type: "prompts" });
  assertEquals((await iterator.next()).value, { type: "prompts" });
  failNext = true;
  const next = iterator.next();
  await new Promise((resolve) => setTimeout(resolve, 30));
  log.append({ type: "resources" });
  assertEquals((await next).value, { type: "resources" });
  assertEquals(errors.length, 1);
  // The hub restarted: a new epoch means events may be lost.
  log = new ChangeLog({ epoch: "b" });
  assertEquals((await iterator.next()).value, { type: "reset" });
  stop.abort();
  await iterator.return?.();
});

Deno.test("the hub Durable Object and its Worker-side source", async () => {
  const hub = new McpChangeHub({} as DurableObjectState, {});
  let threw = false;
  try {
    hub.publish({ type: "nope" } as unknown as ChangeEvent);
  } catch {
    threw = true;
  }
  assert(threw, "rejects a malformed event");
  const namespace = {
    getByName: () => hub,
  } as unknown as DurableObjectNamespace<ChangeHubApi>;
  const source = durableChangeSource(namespace, "default", { waitMs: 50 });
  const stop = new AbortController();
  const iterator = (await source.listen(stop.signal))[Symbol.asyncIterator]();
  await source.publish({ type: "resource", uri: "config://app" });
  assertEquals((await iterator.next()).value, {
    type: "resource",
    uri: "config://app",
  });
  const batch: ChangeBatch = await hub.poll(null, 0);
  assertEquals(batch.seq, 1);
  stop.abort();
  await iterator.return?.();
});

Deno.test("change events expand to the notifications a filter wants", () => {
  const filter = {
    toolsListChanged: true,
    resourceSubscriptions: ["a://1", "a://2"],
  };
  assertEquals(expand({ type: "tools" }, filter), [
    { method: "notifications/tools/list_changed" },
  ]);
  assertEquals(expand({ type: "prompts" }, filter), []);
  assertEquals(expand({ type: "resource", uri: "a://3" }, filter), []);
  assertEquals(
    expand({ type: "reset" }, filter).map((n) => n.params?.uri ?? n.method),
    [
      "notifications/tools/list_changed",
      "a://1",
      "a://2",
    ],
  );
});

Deno.test("listen: acknowledgement first, only opted-in types, tagged", async () => {
  const changes = new MemoryChangeSource();
  const server = demoServer({ changes });
  const seen: JSONRPCNotification[] = [];
  const stop = new AbortController();
  const done = server.handle(
    request("subscriptions/listen", {
      notifications: {
        toolsListChanged: true,
        resourceSubscriptions: ["config://app"],
      },
    }, { id: "sub-1" }),
    { signal: stop.signal, emit: (n) => void seen.push(n) },
  );
  await until(() => seen.length === 1, "ack");
  assertEquals(seen[0], {
    jsonrpc: "2.0",
    method: "notifications/subscriptions/acknowledged",
    params: {
      notifications: {
        toolsListChanged: true,
        resourceSubscriptions: ["config://app"],
      },
      _meta: { [META.subscriptionId]: "sub-1" },
    },
  });
  changes.publish({ type: "prompts" });
  changes.publish({ type: "resource", uri: "config://other" });
  changes.publish({ type: "tools" });
  changes.publish({ type: "resource", uri: "config://app" });
  await until(() => seen.length === 3, "notifications");
  assertEquals(seen.slice(1), [
    {
      jsonrpc: "2.0",
      method: "notifications/tools/list_changed",
      params: { _meta: { [META.subscriptionId]: "sub-1" } },
    },
    {
      jsonrpc: "2.0",
      method: "notifications/resources/updated",
      params: {
        uri: "config://app",
        _meta: { [META.subscriptionId]: "sub-1" },
      },
    },
  ]);
  // The client closing the stream ends it with no response.
  stop.abort();
  assertEquals(await done, null);
  assertEquals(changes.listeners, 0);
});

Deno.test("listen: unsupported types are omitted from the acknowledgement", async () => {
  const seen: JSONRPCNotification[] = [];
  // Without a change source nothing can be honoured, so the stream ends at once.
  const result = resultOf(
    await demoServer().handle(
      request("subscriptions/listen", {
        notifications: { toolsListChanged: true, promptsListChanged: true },
      }, { id: 3 }),
      { emit: (n) => void seen.push(n) },
    ),
  );
  assertEquals(seen.map((n) => n.params?.notifications), [{}]);
  assertEquals(result._meta, {
    [META.subscriptionId]: 3,
    [META.serverInfo]: { name: "demo", version: "0.1.0" },
  });
  assertEquals(result.resultType, "complete");
});

Deno.test("listen: the server's graceful end is a result tagged with the id", async () => {
  const changes = new MemoryChangeSource();
  const server = demoServer({ changes, listenLifetimeMs: 20 });
  const seen: JSONRPCNotification[] = [];
  const result = resultOf(
    await server.handle(
      request("subscriptions/listen", {
        notifications: { promptsListChanged: true },
      }, { id: 7 }),
      { emit: (n) => void seen.push(n) },
    ),
  );
  assertEquals(
    result._meta?.[META.subscriptionId as keyof typeof result._meta],
    7,
  );
  assertEquals(seen.length, 1);
  assertEquals(changes.listeners, 0);
});

Deno.test("the client's listen: acknowledged, iterated, invalidates the cache", async () => {
  const changes = new MemoryChangeSource();
  const server = demoServer({
    changes,
    cache: { ttlMs: 60000, scope: "public" },
  });
  const cache = memoryCache();
  const client = new McpClient({
    transport: inProcessTransport(server),
    info: CLIENT_INFO,
    cache,
  });
  await client.listTools();
  assertEquals(cache.size, 1);
  const subscription = client.listen({
    toolsListChanged: true,
    promptsListChanged: true,
  });
  assertEquals(await subscription.acknowledged, {
    toolsListChanged: true,
    promptsListChanged: true,
  });
  changes.publish({ type: "tools" });
  const received: ServerNotification[] = [];
  for await (const notification of subscription) {
    received.push(notification);
    break;
  }
  assertEquals(received.map((n) => n.method), [
    "notifications/tools/list_changed",
  ]);
  assertEquals(cache.size, 0);
  assertEquals(subscription.endedGracefully, false);
  await until(() => changes.listeners === 0, "the server to see the close");
});

Deno.test("the client's listen over HTTP ends gracefully when the server does", async () => {
  const changes = new MemoryChangeSource();
  const server = demoServer({ changes, listenLifetimeMs: 50 });
  const client = McpClient.http("https://mcp.test/mcp", {
    info: CLIENT_INFO,
    fetch: handlerFetch(mcpHttpHandler(server, { path: "/mcp" })),
  });
  const subscription = client.listen({
    resourceSubscriptions: ["config://app"],
  });
  assertEquals(await subscription.acknowledged, {
    resourceSubscriptions: ["config://app"],
  });
  changes.publish({ type: "resource", uri: "config://app" });
  const received: ServerNotification[] = [];
  for await (const notification of subscription) received.push(notification);
  assertEquals(received.length, 1);
  assertEquals(received[0].params, {
    uri: "config://app",
    _meta: { [META.subscriptionId]: 1 },
  });
  assert(subscription.endedGracefully, "graceful");
});

Deno.test("the client refuses a stream tagged for another subscription", async () => {
  const client = new McpClient({
    info: CLIENT_INFO,
    transport: {
      request(message, { onNotification }) {
        onNotification({
          jsonrpc: "2.0",
          method: "notifications/subscriptions/acknowledged",
          params: {
            notifications: {},
            _meta: { [META.subscriptionId]: "other" },
          },
        });
        return Promise.resolve({
          jsonrpc: "2.0",
          id: message.id,
          result: { resultType: "complete" },
        });
      },
    },
  });
  const subscription = client.listen({});
  let message = "";
  try {
    for await (const _ of subscription) { /* nothing */ }
  } catch (error) {
    message = (error as Error).message;
  }
  assertEquals(
    message,
    'a listen notification carries subscriptionId "other", expected 1',
  );
});

// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

import { assertEquals } from "@celld/assert";
import {
  cacheKey,
  type JSONRPCRequest,
  McpClient,
  McpServer,
  memoryCache,
  type Transport,
} from "@celld/mcp";
import { inProcessTransport } from "@celld/mcp/testing";
import { CLIENT_INFO, demoServer, SECRET, SERVER_INFO } from "./fixture.ts";

/** Counts the requests that reach the server, per method. */
function counting(server: McpServer) {
  const counts: Record<string, number> = {};
  const inner = inProcessTransport(server);
  const transport: Transport = {
    request(message: JSONRPCRequest, options) {
      counts[message.method] = (counts[message.method] ?? 0) + 1;
      return inner.request(message, options);
    },
  };
  return { transport, counts };
}

Deno.test("the memory cache stores, invalidates and evicts", () => {
  const cache = memoryCache(2);
  const entry = (method: string, uri?: string) => ({
    result: { resultType: "complete" },
    expiresAt: 10,
    method,
    uri,
  });
  cache.set("a", entry("tools/list"));
  cache.set("b", entry("resources/read", "x://1"));
  cache.set("c", entry("resources/read", "x://2"));
  assertEquals(cache.size, 2);
  assertEquals(cache.get("a"), undefined);
  cache.invalidate("resources/read", "x://1");
  assertEquals([cache.get("b"), cache.get("c")?.uri], [undefined, "x://2"]);
  cache.invalidate("resources/read");
  assertEquals(cache.size, 0);
});

Deno.test("cache keys are method plus the params that matter", () => {
  const key = (params: Record<string, unknown>) =>
    cacheKey("tools/list", params, "public");
  assertEquals(key({ _meta: { a: 1 } }), key({ _meta: { b: 2 } }));
  assertEquals(key({ cursor: "x", b: 1 }) === key({ b: 1, cursor: "x" }), true);
  assertEquals(key({ cursor: "x" }) === key({ cursor: "y" }), false);
  assertEquals(
    cacheKey("tools/list", {}, "public") ===
      cacheKey("tools/list", {}, "private:a"),
    false,
  );
});

Deno.test("fresh public results are served from the cache until the TTL", async () => {
  let now = 0;
  const { transport, counts } = counting(
    demoServer({ cache: { ttlMs: 1000, scope: "public" } }),
  );
  const client = new McpClient({
    transport,
    info: CLIENT_INFO,
    cache: memoryCache(),
    now: () => now,
  });
  await client.listTools();
  await client.listTools();
  assertEquals(counts["tools/list"], 1);
  // A different cursor is a different request.
  await client.discover();
  await client.discover();
  assertEquals(counts["server/discover"], 1);
  now = 999;
  await client.listTools();
  assertEquals(counts["tools/list"], 1);
  now = 1000;
  await client.listTools();
  assertEquals(counts["tools/list"], 2);
  await client.listTools(undefined, { fresh: true });
  assertEquals(counts["tools/list"], 3);
  // Resource reads are keyed by URI and use the resource's own hints.
  await client.readResource("config://app");
  await client.readResource("config://app");
  await client.readResource("file:///a.txt");
  assertEquals(counts["resources/read"], 2);
});

Deno.test("private results need, and stay within, an authorization context", async () => {
  const server = demoServer({ cache: { ttlMs: 1000, scope: "private" } });
  const { transport, counts } = counting(server);
  const shared = memoryCache();
  const anonymous = new McpClient({
    transport,
    info: CLIENT_INFO,
    cache: shared,
  });
  await anonymous.listTools();
  await anonymous.listTools();
  assertEquals(counts["tools/list"], 2);
  const alice = new McpClient({
    transport,
    info: CLIENT_INFO,
    cache: shared,
    cacheContext: "alice",
  });
  const bob = new McpClient({
    transport,
    info: CLIENT_INFO,
    cache: shared,
    cacheContext: "bob",
  });
  await alice.listTools();
  await alice.listTools();
  assertEquals(counts["tools/list"], 3);
  await bob.listTools();
  assertEquals(counts["tools/list"], 4);
});

Deno.test("zero TTLs and MRTR retries are never cached", async () => {
  const server = new McpServer({
    info: SERVER_INFO,
    stateSecret: SECRET,
    cache: { ttlMs: 0, scope: "public" },
  });
  server.tool({ name: "t", run: () => "" });
  server.resource({
    uri: "x://gated",
    name: "gated",
    cache: { ttlMs: 60000, scope: "public" },
    read: (ctx) =>
      ctx.state === null ? ctx.inputRequired({ state: 1 }) : "opened",
  });
  const { transport, counts } = counting(server);
  const cache = memoryCache();
  const client = new McpClient({ transport, info: CLIENT_INFO, cache });
  await client.listTools();
  await client.listTools();
  assertEquals(counts["tools/list"], 2);
  assertEquals((await client.readResource("x://gated")).contents[0], {
    uri: "x://gated",
    text: "opened",
  });
  assertEquals(counts["resources/read"], 2);
  assertEquals(cache.size, 0);
});

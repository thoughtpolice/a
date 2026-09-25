// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * Regressions for the wave-4 sweep (WP-13) against `@celld/mcp`: listen
 * streams bounded by the credential, anonymous idempotency and task
 * tokens, live configuration, the client's transport rule and cache
 * namespace, and the router options of the HTTP handler. Each is named by
 * its `DB-SWP` identifier and failed on the code before it.
 *
 * @module
 */

import { assert, assertEquals } from "@celld/core/assert";
import {
  type ClientCapabilities,
  type IdempotencyStore,
  McpClient,
  mcpHttpHandler,
  McpServer,
  memoryCache,
  MemoryChangeSource,
  TASKS_EXTENSION,
  unsafeMemoryIdempotencyStore,
  UnsafeMemoryTaskStore,
} from "@celld/mcp";
import { testPrincipal } from "@celld/mcp/testing";
import { ResourceServer } from "@celld/sec/oauth/resource";
import { toPrincipal } from "@celld/web/router";
import {
  CLIENT_INFO,
  demoServer,
  request,
  SECRET,
  SERVER_INFO,
} from "./fixture.ts";

const CAPS: ClientCapabilities = { extensions: { [TASKS_EXTENSION]: {} } };
const TASK_TOKEN = "celld/task-token";
const IDEMPOTENCY = "celld/idempotency-key";

// deno-lint-ignore no-explicit-any
const loose = (value: unknown): any => value;

function within<T>(promise: Promise<T>, ms: number): Promise<T | "hung"> {
  let timer: number | undefined;
  return Promise.race([
    promise,
    new Promise<"hung">((resolve) => {
      timer = setTimeout(() => resolve("hung"), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

// ----- DB-SWP-F4-13.M1: listen streams end with the credential -----

Deno.test("DB-SWP-F4-13.M1: a listen stream ends when its credential expires", async () => {
  const server = new McpServer({
    info: SERVER_INFO,
    stateSecret: SECRET,
    changes: new MemoryChangeSource(),
  });
  server.tool({ name: "t", run: () => "" });
  const listen = (
    expiresAt: number,
    lifetime?: McpServer,
    signal = new AbortController().signal,
  ) =>
    (lifetime ?? server).handle(
      request("subscriptions/listen", {
        notifications: { toolsListChanged: true },
      }),
      {
        principal: toPrincipal({ subject: "u", expiresAt }, "bearer"),
        signal,
        emit: () => {},
      },
    );
  const leave = new AbortController();
  const open = listen(Date.now() + 60_000, undefined, leave.signal);
  const control = await within(open, 200);
  leave.abort();
  await open;
  assertEquals(control, "hung", "a stream with a live token stays open");
  const soon = await within(listen(Date.now() + 50), 2000);
  assert(soon !== "hung", "a stream ends when the token expires");
  assert(
    soon !== null && "result" in soon,
    `gracefully: ${JSON.stringify(soon)}`,
  );
  const expired = await within(listen(Date.now() - 1000), 2000);
  assert(expired !== "hung", "an expired token's stream ends at once");
  const short = new McpServer({
    info: SERVER_INFO,
    stateSecret: SECRET,
    changes: new MemoryChangeSource(),
    listenLifetimeMs: 50,
  });
  short.tool({ name: "t", run: () => "" });
  const lifetime = await within(listen(Date.now() + 60_000, short), 2000);
  assert(lifetime !== "hung", "a shorter lifetime still wins");
  let threw = false;
  try {
    new McpServer({ info: SERVER_INFO, listenLifetimeMs: Number.NaN });
  } catch (error) {
    threw = error instanceof RangeError;
  }
  assert(threw, "a NaN lifetime is refused, not read as never");
});

// ----- DB-SWP-F11-13.M1: anonymous idempotency never replays a token -----

Deno.test("DB-SWP-F11-13.M1: an anonymous keyed task creation never replays its token", async () => {
  const inner = unsafeMemoryIdempotencyStore();
  const stored: unknown[] = [];
  const store: IdempotencyStore = {
    claim: (...args) => inner.claim(...args),
    complete: (slot, token, value) => {
      stored.push(value);
      return inner.complete(slot, token, value);
    },
  } as IdempotencyStore;
  const server = new McpServer({
    info: SERVER_INFO,
    stateSecret: SECRET,
    tasks: { store: new UnsafeMemoryTaskStore(), pollIntervalMs: 10 },
    idempotency: { store },
  });
  server.tool({
    name: "open-job",
    task: { run: () => new Promise<string>(() => {}) },
  });
  const create = () =>
    server.handle(
      request("tools/call", { name: "open-job" }, {
        capabilities: CAPS,
        meta: { [IDEMPOTENCY]: "k-1" },
      }),
      { principal: null },
    );
  const first = await create();
  const token = (first as { result: { _meta?: Record<string, unknown> } })
    .result._meta?.[TASK_TOKEN];
  assert(typeof token === "string", "the creator gets the token");
  const again = await create();
  assert(
    !JSON.stringify(again).includes(token as string),
    `a repeat of the key does not get the token: ${JSON.stringify(again)}`,
  );
  assert("error" in again!, "the repeat is refused");
  assert(
    !JSON.stringify(stored).includes(token as string),
    "the token is never stored in an idempotency slot",
  );
});

// ----- DB-SWP-F15-13.M1: server options and definitions -----

Deno.test("DB-SWP-F15-13.M1: tool definitions and server options are copied", async () => {
  const versions = ["2026-07-28"];
  const server = new McpServer({
    info: SERVER_INFO,
    stateSecret: SECRET,
    versions,
  });
  versions.push("1999-01-01");
  assertEquals([...server.versions], ["2026-07-28"]);
  const scopes = ["notes:write"];
  const definition = { name: "write", scopes, run: () => "ok" };
  server.tool(definition);
  scopes.length = 0;
  loose(definition).scopes = [];
  const outcome = await server.handle(
    request("tools/call", { name: "write" }),
    { principal: testPrincipal("a") },
  ).then((response) => response, (error) => error);
  assert(
    outcome instanceof Error,
    `the tool still needs its scope: ${JSON.stringify(outcome)}`,
  );
  let threw = false;
  try {
    server.tool({ name: "bad", scopes: "admin" as never, run: () => "" });
  } catch (error) {
    threw = error instanceof TypeError;
  }
  assert(threw, "scopes must be a list of scope strings");
});

// ----- DB-SWP-F15-13.M2: the Origin allowlist -----

Deno.test("DB-SWP-F15-13.M2: allowed origins are copied at registration", async () => {
  const origins = ["https://app.test"];
  const handler = mcpHttpHandler(demoServer(), {
    path: "/mcp",
    public: true,
    allowedOrigins: origins,
  });
  origins.push("https://evil.test");
  const answer = await handler(
    new Request("https://mcp.test/mcp", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "mcp-protocol-version": "2026-07-28",
        "mcp-method": "tools/list",
        origin: "https://evil.test",
      },
      body: JSON.stringify(request("tools/list", {})),
    }),
  );
  assertEquals(answer.status, 403);
});

// ----- DB-SWP-F16-13.M1: the client's transport rule -----

Deno.test("DB-SWP-F16-13.M1: the client sends credentials only over https, never through a redirect", async () => {
  const reached: RequestInit[] = [];
  const fetch = (_input: string | URL | Request, init?: RequestInit) => {
    reached.push(init ?? {});
    return Promise.resolve(new Response(null, { status: 500 }));
  };
  const options = {
    info: CLIENT_INFO,
    headers: { authorization: "Bearer secret-token" },
    fetch,
  };
  for (
    const url of [
      "http://mcp.example.com/mcp",
      "http://localhost:8080/mcp",
      "https://user:pass@mcp.test/mcp",
      "http://127.0.0.1:8080/mcp",
    ]
  ) {
    let threw = false;
    try {
      await McpClient.http(url, options).listTools();
    } catch (error) {
      threw = error instanceof Error;
    }
    assert(threw, `${url} is refused`);
  }
  assertEquals(reached.length, 0, "no credential was sent");
  await McpClient.http("http://127.0.0.1:8080/mcp", {
    ...options,
    allowLoopbackForDevelopment: true,
  }).listTools().catch(() => {});
  await McpClient.http("https://mcp.test/mcp", options).listTools()
    .catch(() => {});
  assertEquals(reached.map((init) => init.redirect), ["error", "error"]);
});

// ----- DB-SWP-F5-13.M1: the client cache is per endpoint -----

Deno.test("DB-SWP-F5-13.M1: one cache shared by clients of two endpoints keeps them apart", async () => {
  const cached = { cache: { ttlMs: 60_000, scope: "public" as const } };
  const a = demoServer(cached);
  const b = demoServer(cached);
  b.tool({ name: "only-on-b", run: () => "b" });
  const handlers: Record<string, (request: Request) => Promise<Response>> = {
    "https://a.test": mcpHttpHandler(a, { public: true }),
    "https://b.test": mcpHttpHandler(b, { public: true }),
  };
  const fetch = (input: string | URL | Request, init?: RequestInit) => {
    const request = new Request(input, init);
    return handlers[new URL(request.url).origin](request);
  };
  const cache = memoryCache();
  const first = McpClient.http("https://a.test/mcp", {
    info: CLIENT_INFO,
    fetch,
    cache,
  });
  const second = McpClient.http("https://b.test/mcp", {
    info: CLIENT_INFO,
    fetch,
    cache,
  });
  await first.listTools();
  const names = (await second.listTools()).tools.map((tool) => tool.name);
  assert(names.includes("only-on-b"), `b's own tools: ${names}`);
});

// ----- DB-SWP-F16-13.M2: the HTTP handler takes router options -----

Deno.test("DB-SWP-F16-13.M2: behind a TLS proxy the handler's router knows its public URL", async () => {
  const resource = new ResourceServer({
    resource: "https://mcp.example/mcp",
    authorizationServers: ["https://as.example"],
    dpop: false,
    verifier: {
      verify: () =>
        Promise.resolve({
          subject: "u",
          scopes: [],
          audience: ["https://mcp.example/mcp"],
          claims: {},
        }),
    },
  });
  const handler = mcpHttpHandler(demoServer(), {
    path: "/mcp",
    resource,
    router: { publicUrl: { mode: "fixed", origin: "https://mcp.example" } },
  });
  const answer = await handler(
    new Request("http://10.0.0.7/mcp", {
      method: "POST",
      headers: {
        authorization: "Bearer t",
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "mcp-protocol-version": "2026-07-28",
        "mcp-method": "tools/list",
      },
      body: JSON.stringify(request("tools/list", {})),
    }),
  );
  assertEquals(answer.status, 200);
});

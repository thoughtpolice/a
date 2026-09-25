// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

import { assert, assertEquals } from "@celld/assert";
import { sseEvents } from "@celld/http/sse";
import {
  encodeHeaderValue,
  type HttpHandlerOptions,
  mcpHttpHandler,
  mcpRoutes,
  McpServer,
  META,
} from "@celld/mcp";
import { ProtocolError } from "@celld/oauth";
import { ResourceServer } from "@celld/oauth/resource";
import { bearer, router } from "@celld/router";
import { demoServer, request, SERVER_INFO } from "./fixture.ts";

const URL_ = "https://mcp.test/mcp";

function post(
  body: unknown,
  headers: Record<string, string | null> = {},
): Request {
  const message = body as { method?: string; params?: Record<string, unknown> };
  const base: Record<string, string> = {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
    "mcp-protocol-version": "2026-07-28",
  };
  if (typeof message?.method === "string") base["mcp-method"] = message.method;
  const name = message?.params?.name ?? message?.params?.uri;
  if (typeof name === "string") base["mcp-name"] = encodeHeaderValue(name);
  for (const [key, value] of Object.entries(headers)) {
    if (value === null) delete base[key];
    else base[key] = value;
  }
  return new Request(URL_, {
    method: "POST",
    headers: base,
    body: typeof body === "string" || body instanceof Uint8Array
      ? body as BodyInit
      : JSON.stringify(body),
  });
}

function handler(options: HttpHandlerOptions = {}, server = demoServer()) {
  return mcpHttpHandler(server, { path: "/mcp", ...options });
}

async function json(response: Response) {
  assertEquals(response.headers.get("content-type"), "application/json");
  return await response.json();
}

Deno.test("a request gets a JSON response with its result", async () => {
  const message = request("tools/call", {
    name: "echo",
    arguments: { text: "hi" },
  }, {
    id: "abc",
  });
  const response = await handler()(post(message));
  assertEquals(response.status, 200);
  assertEquals(await json(response), {
    jsonrpc: "2.0",
    id: "abc",
    result: {
      content: [{ type: "text", text: "hi" }],
      resultType: "complete",
      _meta: { [META.serverInfo]: SERVER_INFO },
    },
  });
});

Deno.test("only POST: GET and DELETE are the router's 405", async () => {
  for (const method of ["GET", "DELETE", "PUT"]) {
    const response = await handler()(new Request(URL_, { method }));
    assertEquals(response.status, 405, method);
    assertEquals(response.headers.get("allow"), "OPTIONS, POST");
    const body = await json(response);
    assertEquals(body.error, "method_not_allowed");
  }
  const options = await handler()(new Request(URL_, { method: "OPTIONS" }));
  assertEquals(options.status, 204);
  assertEquals(options.headers.get("allow"), "OPTIONS, POST");
});

Deno.test("other paths are 404; notifications are 202", async () => {
  const other = await handler()(
    new Request("https://mcp.test/other", { method: "POST" }),
  );
  assertEquals(other.status, 404);
  assertEquals((await json(other)).error, "not_found");
  const accepted = await handler()(post({
    jsonrpc: "2.0",
    method: "notifications/cancelled",
    params: { requestId: 1 },
  }));
  assertEquals(accepted.status, 202);
  assertEquals(await accepted.text(), "");
});

Deno.test("browser origins are refused unless allowed", async () => {
  const message = request("tools/list");
  const refused = await handler()(
    post(message, { origin: "https://evil.example" }),
  );
  assertEquals(refused.status, 403);
  assertEquals((await json(refused)).error.code, -32600);
  // Before authentication, too: no 401 for a cross-origin request.
  const guarded = await handler({ resource: resourceServer() })(
    post(message, { origin: "https://evil.example" }),
  );
  assertEquals(guarded.status, 403);
  assertEquals((await json(guarded)).error.code, -32600);
  const allowed = await handler({ allowedOrigins: ["https://app.example"] })(
    post(message, { origin: "https://app.example" }),
  );
  assertEquals(allowed.status, 200);
});

Deno.test("bodies must be JSON-RPC requests, one at a time", async () => {
  const cases: [BodyInit, Record<string, string | null>, number, number][] = [
    ["{oops", {}, 400, -32700],
    [JSON.stringify([request("tools/list")]), {}, 400, -32600],
    [JSON.stringify({ jsonrpc: "2.0", id: 1, result: {} }), {}, 400, -32600],
    [
      JSON.stringify(request("tools/list")),
      { "content-type": "text/plain" },
      415,
      -32600,
    ],
  ];
  for (const [body, headers, status, code] of cases) {
    const response = await handler()(post(body, headers));
    assertEquals(response.status, status, String(body));
    assertEquals((await json(response)).error.code, code);
  }
  const big = await handler({ maxBodyBytes: 10 })(post(request("tools/list")));
  assertEquals(big.status, 413);
  assertEquals((await json(big)).error.code, -32600);
  // A declared Content-Length over the limit is the router's 413.
  const declared = await handler({ maxBodyBytes: 10 })(
    post(request("tools/list"), { "content-length": "4000" }),
  );
  assertEquals(declared.status, 413);
  const notUtf8 = await handler()(post(new Uint8Array([0x7b, 0xff, 0x7d])));
  assertEquals(notUtf8.status, 400);
  assertEquals((await json(notUtf8)).error.code, -32700);
});

Deno.test("standard headers must be present and match the body", async () => {
  const message = request("tools/call", {
    name: "echo",
    arguments: { text: "x" },
  }, {
    id: 9,
  });
  const expectMismatch = async (
    headers: Record<string, string | null>,
    text: string,
  ) => {
    const response = await handler()(post(message, headers));
    assertEquals(response.status, 400);
    assertEquals(await json(response), {
      jsonrpc: "2.0",
      id: 9,
      error: { code: -32020, message: `Header mismatch: ${text}` },
    });
  };
  await expectMismatch({ "mcp-method": null }, "Mcp-Method is missing");
  await expectMismatch(
    { "mcp-method": "tools/list" },
    "Mcp-Method header value 'tools/list' does not match body value 'tools/call'",
  );
  await expectMismatch({ "mcp-name": null }, "Mcp-Name is missing");
  await expectMismatch(
    { "mcp-name": "other" },
    "Mcp-Name header value 'other' does not match body value 'echo'",
  );
  await expectMismatch(
    { "mcp-protocol-version": null },
    "MCP-Protocol-Version is missing",
  );
  await expectMismatch(
    { "mcp-protocol-version": "2025-11-25" },
    "MCP-Protocol-Version header value '2025-11-25' does not match body value '2026-07-28'",
  );
  // Header names are case-insensitive; an encoded Mcp-Name is decoded.
  const ok = await handler()(
    post(message, { "mcp-name": null, "MCP-NAME": "=?base64?ZWNobw==?=" }),
  );
  assertEquals(ok.status, 200);
});

Deno.test("an Mcp-Name for a resource URI, base64 when it must be", async () => {
  const message = request("resources/read", { uri: "file:///dir/é.txt" });
  const response = await handler()(post(message));
  assertEquals(response.status, 200);
  assertEquals(
    (await json(response)).result.contents[0].text,
    "contents of dir/é.txt",
  );
});

Deno.test("protocol errors carry the spec's HTTP statuses", async () => {
  const missingMeta = await handler()(post({
    jsonrpc: "2.0",
    id: 1,
    method: "tools/list",
    params: {},
  }));
  assertEquals(missingMeta.status, 400);
  assertEquals((await json(missingMeta)).error.code, -32602);

  const old = await handler()(
    post(
      request("tools/list", {}, {
        meta: { [META.protocolVersion]: "2025-11-25" },
      }),
      {
        "mcp-protocol-version": "2025-11-25",
      },
    ),
  );
  assertEquals(old.status, 400);
  assertEquals((await json(old)).error.data, {
    supported: ["2026-07-28"],
    requested: "2025-11-25",
  });

  const unknown = await handler()(post(request("ping")));
  assertEquals(unknown.status, 404);
  assertEquals((await json(unknown)).error.code, -32601);

  const capability = await handler()(
    post(request("tools/call", { name: "login" })),
  );
  assertEquals(capability.status, 400);
  assertEquals((await json(capability)).error.code, -32021);

  // An error while running a request is a JSON-RPC error with 200.
  const notFound = await handler()(
    post(request("resources/read", { uri: "nope://x" })),
  );
  assertEquals(notFound.status, 200);
  assertEquals((await json(notFound)).error.code, -32602);
});

Deno.test("Mcp-Param headers are checked against x-mcp-header arguments", async () => {
  const call = (args: Record<string, unknown>) =>
    request("tools/call", { name: "query", arguments: args }, { id: 1 });
  const ok = await handler()(
    post(call({ region: "eu", limit: 5, dry: true, sql: "q" }), {
      "mcp-param-region": "eu",
      "mcp-param-limit": "5",
      "mcp-param-dry": "true",
    }),
  );
  assertEquals(ok.status, 200);
  const missing = await handler()(post(call({ region: "eu", sql: "q" })));
  assertEquals(missing.status, 400);
  assertEquals(
    (await json(missing)).error.message,
    "Header mismatch: Mcp-Param-Region is missing",
  );
  const wrong = await handler()(
    post(call({ region: "eu", sql: "q" }), { "mcp-param-region": "us" }),
  );
  assertEquals((await json(wrong)).error.code, -32020);
  const extra = await handler()(
    post(call({ region: "eu", sql: "q" }), {
      "mcp-param-region": "eu",
      "mcp-param-limit": "1",
    }),
  );
  assertEquals(
    (await json(extra)).error.message,
    "Header mismatch: Mcp-Param-Limit is present but the argument is absent",
  );
});

Deno.test("a request that reports progress streams SSE", async () => {
  const server = new McpServer({ info: SERVER_INFO });
  server.tool({
    name: "work",
    run: async (_args, ctx) => {
      ctx.progress(1, { total: 2 });
      await new Promise((resolve) => setTimeout(resolve, 5));
      ctx.progress(2, { total: 2, message: "done" });
      return "finished";
    },
  });
  const message = request("tools/call", { name: "work" }, {
    id: 4,
    meta: { progressToken: "tok" },
  });
  const response = await handler({}, server)(post(message));
  assertEquals(response.status, 200);
  assertEquals(response.headers.get("content-type"), "text/event-stream");
  assertEquals(response.headers.get("x-accel-buffering"), "no");
  const events = [];
  for await (const event of sseEvents(response.body!)) {
    assertEquals(event.event, "message");
    events.push(JSON.parse(event.data));
  }
  assertEquals(events.map((e) => e.method ?? `response ${e.id}`), [
    "notifications/progress",
    "notifications/progress",
    "response 4",
  ]);
  assertEquals(events[1].params, {
    progressToken: "tok",
    progress: 2,
    total: 2,
    message: "done",
  });
  assertEquals(events[2].result.content, [{ type: "text", text: "finished" }]);

  // Without a progress token the same call is plain JSON.
  const plain = await handler({}, server)(
    post(request("tools/call", { name: "work" })),
  );
  assertEquals(plain.headers.get("content-type"), "application/json");
  // A client that cannot take SSE gets JSON, and no notifications.
  const noSse = await handler({}, server)(
    post(message, { accept: "application/json" }),
  );
  assertEquals(noSse.headers.get("content-type"), "application/json");
});

Deno.test("subscriptions/listen needs Accept: text/event-stream", async () => {
  const response = await handler()(
    post(request("subscriptions/listen", { notifications: {} }), {
      accept: "application/json",
    }),
  );
  assertEquals(response.status, 406);
});

Deno.test("session and resumption headers from old clients are ignored", async () => {
  const response = await handler()(
    post(request("tools/list"), {
      "mcp-session-id": "abc",
      "last-event-id": "7",
    }),
  );
  assertEquals(response.status, 200);
  assertEquals(response.headers.get("mcp-session-id"), null);
});

const METADATA = "https://mcp.test/.well-known/oauth-protected-resource/mcp";

/** A resource server whose tokens are `good` (scope `mcp`) and `weak`. */
function resourceServer(): ResourceServer {
  return new ResourceServer({
    resource: "https://mcp.test/mcp",
    authorizationServers: ["https://auth.test"],
    scopesSupported: ["mcp"],
    dpop: false,
    verifier: {
      verify: (token) => {
        if (token !== "good" && token !== "weak") {
          return Promise.reject(
            new ProtocolError("invalid_token", {
              status: 401,
              description: "unknown token",
            }),
          );
        }
        return Promise.resolve({
          subject: token === "good" ? "u1" : "u2",
          scopes: token === "good" ? ["mcp"] : [],
          audience: ["https://mcp.test/mcp"],
          claims: {},
        });
      },
    },
  });
}

Deno.test("OAuth: 401 and 403 with WWW-Authenticate, and the metadata document", async () => {
  const server = demoServer();
  server.tool({ name: "secret", scopes: ["mcp"], run: () => "classified" });
  const protectedHandler = handler({ resource: resourceServer() }, server);
  const message = request("tools/call", { name: "secret" });
  const none = await protectedHandler(post(message));
  assertEquals(none.status, 401);
  assertEquals(
    none.headers.get("www-authenticate"),
    `Bearer resource_metadata="${METADATA}"`,
  );
  assertEquals(none.headers.get("cache-control"), "no-store");
  const bad = await protectedHandler(
    post(message, { authorization: "Bearer nope" }),
  );
  assertEquals(bad.status, 401);
  assertEquals(
    bad.headers.get("www-authenticate"),
    `Bearer error="invalid_token", error_description="unknown token", resource_metadata="${METADATA}"`,
  );
  const weak = await protectedHandler(
    post(message, { authorization: "Bearer weak" }),
  );
  assertEquals(weak.status, 403);
  assertEquals(
    weak.headers.get("www-authenticate"),
    `Bearer error="insufficient_scope", error_description="Missing scopes: mcp", scope="mcp", resource_metadata="${METADATA}"`,
  );
  assertEquals((await json(weak)).error, "insufficient_scope");
  // The weak token is fine for everything else.
  assertEquals(
    (await protectedHandler(
      post(request("tools/list"), { authorization: "Bearer weak" }),
    )).status,
    200,
  );
  const good = await protectedHandler(
    post(message, { authorization: "Bearer good" }),
  );
  assertEquals(good.status, 200);
  assertEquals((await json(good)).result.content[0].text, "classified");

  for (
    const path of [
      "/.well-known/oauth-protected-resource/mcp",
      "/.well-known/oauth-protected-resource",
    ]
  ) {
    const document = await protectedHandler(
      new Request(`https://mcp.test${path}`),
    );
    assertEquals(document.status, 200);
    assertEquals((await document.json()).authorization_servers, [
      "https://auth.test",
    ]);
  }
});

Deno.test("without auth, a tool with scopes is refused", async () => {
  const server = demoServer();
  server.tool({ name: "secret", scopes: ["mcp"], run: () => "classified" });
  const response = await handler({}, server)(
    post(request("tools/call", { name: "secret" })),
  );
  assertEquals(response.status, 403);
  assertEquals(response.headers.get("www-authenticate"), null);
  assertEquals((await json(response)).error, "insufficient_scope");
});

Deno.test("mcpRoutes puts the endpoint on an application's own router", async () => {
  const app = router({
    auth: bearer({
      verify: ({ token }) => token === "t1" ? { subject: "user:t1" } : null,
    }),
  });
  app.get("/health", { public: true }, (c) => c.json({ ok: true }));
  const server = new McpServer({ info: SERVER_INFO });
  server.tool({
    name: "whoami",
    run: (_args, ctx) => ctx.principal?.subject ?? "nobody",
  });
  mcpRoutes(app, "/mcp", server);
  assertEquals(
    (await app.fetch(new Request("https://mcp.test/health"))).status,
    200,
  );
  const anonymous = await app.fetch(
    post(request("tools/call", { name: "whoami" })),
  );
  assertEquals(anonymous.status, 401);
  const response = await app.fetch(
    post(request("tools/call", { name: "whoami" }), {
      authorization: "Bearer t1",
    }),
  );
  assertEquals((await json(response)).result.content[0].text, "user:t1");
  // Security headers from the router, on the MCP answer too.
  assertEquals(response.headers.get("x-content-type-options"), "nosniff");
  assert(response.headers.get("x-request-id") !== null, "request id");
});

Deno.test("the client going away cancels the request", async () => {
  const server = new McpServer({ info: SERVER_INFO });
  let seen: AbortSignal | null = null;
  server.tool({
    name: "wait",
    run: (_args, ctx) =>
      new Promise((resolve) => {
        seen = ctx.signal;
        ctx.signal.addEventListener("abort", () => resolve("cancelled"));
      }),
  });
  const gone = new AbortController();
  const message = post(request("tools/call", { name: "wait" }));
  const pending = handler({}, server)(
    new Request(message, { signal: gone.signal }),
  );
  while (seen === null) await new Promise((resolve) => setTimeout(resolve, 1));
  gone.abort();
  const response = await pending;
  assertEquals(response.status, 499);
  assert((seen as AbortSignal).aborted, "the handler's signal aborted");
});

Deno.test("a route timeout is the router's 503", async () => {
  const server = new McpServer({ info: SERVER_INFO });
  server.tool({
    name: "slow",
    run: (_args, ctx) =>
      new Promise((resolve) => {
        const timer = setTimeout(() => resolve("done"), 5_000);
        ctx.signal.addEventListener("abort", () => {
          clearTimeout(timer);
          resolve("stopped");
        });
      }),
  });
  const response = await handler({ timeout: "PT0.05S" }, server)(
    post(request("tools/call", { name: "slow" })),
  );
  assertEquals(response.status, 503);
  assertEquals((await json(response)).error, "timeout");
});

Deno.test("the principal reaches handlers and binds requestState", async () => {
  const server = new McpServer({ info: SERVER_INFO });
  server.tool({
    name: "whoami",
    run: (_args, ctx) => ctx.principal?.subject ?? "nobody",
  });
  const auth = bearer({
    verify: ({ token }) => ({ subject: `user:${token}` }),
  });
  const response = await handler({ auth }, server)(
    post(request("tools/call", { name: "whoami" }), {
      authorization: "Bearer t1",
    }),
  );
  assertEquals((await json(response)).result.content[0].text, "user:t1");
});

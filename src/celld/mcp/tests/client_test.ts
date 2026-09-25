// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

import { assert, assertEquals } from "@celld/assert";
import {
  type FetchLike,
  type JSONRPCRequest,
  type JSONRPCResponse,
  McpClient,
  McpError,
  mcpHttpHandler,
  McpServer,
  META,
  type Transport,
} from "@celld/mcp";
import { handlerFetch, inProcessTransport } from "@celld/mcp/testing";
import {
  AuthError,
  type AuthOutcome,
  type AuthScheme,
  errorParams,
} from "@celld/router";
import { CLIENT_INFO, demoServer, SECRET, SERVER_INFO } from "./fixture.ts";

async function failure(promise: Promise<unknown>): Promise<McpError> {
  try {
    await promise;
  } catch (error) {
    assert(error instanceof McpError, `not an McpError: ${error}`);
    return error;
  }
  throw new Error("resolved");
}

/** A transport answering from a script, recording what was sent. */
function scripted(
  answer: (message: JSONRPCRequest, index: number) => Record<string, unknown>,
): { transport: Transport; sent: JSONRPCRequest[] } {
  const sent: JSONRPCRequest[] = [];
  return {
    sent,
    transport: {
      request(message) {
        sent.push(message);
        const reply = answer(message, sent.length - 1);
        return Promise.resolve(
          { jsonrpc: "2.0", id: message.id, ...reply } as JSONRPCResponse,
        );
      },
    },
  };
}

/** A fetch into a handler that records each request's headers. */
function recording(handler: (request: Request) => Promise<Response>) {
  const headers: Headers[] = [];
  const fetch: FetchLike = (input, init) => {
    headers.push(new Headers(init?.headers));
    return handlerFetch(handler)(input, init);
  };
  return { fetch, headers };
}

Deno.test("every request carries version, capabilities, client info and headers", async () => {
  const handler = mcpHttpHandler(demoServer());
  const { fetch, headers } = recording(handler);
  const bodies: Record<string, unknown>[] = [];
  const client = McpClient.http("https://mcp.test/mcp", {
    info: CLIENT_INFO,
    handlers: {
      elicitation: () => ({ action: "cancel" }),
      elicitationModes: ["form", "url"],
    },
    fetch: async (input, init) => {
      bodies.push(JSON.parse(String(init?.body)));
      return await fetch(input, init);
    },
  });
  await client.callTool("echo", { text: "hi" });
  const sent = headers[0];
  assertEquals(sent.get("mcp-protocol-version"), "2026-07-28");
  assertEquals(sent.get("mcp-method"), "tools/call");
  assertEquals(sent.get("mcp-name"), "echo");
  assertEquals(sent.get("accept"), "application/json, text/event-stream");
  assertEquals(sent.get("content-type"), "application/json");
  assertEquals((bodies[0].params as Record<string, unknown>)._meta, {
    [META.protocolVersion]: "2026-07-28",
    [META.clientCapabilities]: { elicitation: { form: {}, url: {} } },
    [META.clientInfo]: CLIENT_INFO,
  });
});

Deno.test("discover and inline negotiation choose a shared version", async () => {
  const server = new McpServer({
    info: SERVER_INFO,
    versions: ["2026-07-28", "2027-01-01"],
  });
  server.tool({ name: "t", run: () => "ok" });
  const client = new McpClient({
    transport: inProcessTransport(server),
    info: CLIENT_INFO,
    versions: ["2099-01-01", "2027-01-01", "2026-07-28"],
  });
  const found = await client.discover();
  assertEquals(found.supportedVersions, ["2026-07-28", "2027-01-01"]);
  assertEquals(client.protocolVersion, "2027-01-01");

  const inline = new McpClient({
    transport: inProcessTransport(server),
    info: CLIENT_INFO,
    versions: ["2099-01-01", "2026-07-28"],
  });
  assertEquals((await inline.callTool("t")).content, [{
    type: "text",
    text: "ok",
  }]);
  assertEquals(inline.protocolVersion, "2026-07-28");

  const hopeless = new McpClient({
    transport: inProcessTransport(server),
    info: CLIENT_INFO,
    versions: ["2099-01-01"],
  });
  const error = await failure(hopeless.listTools());
  assertEquals(error.kind, "unsupported_version");
});

Deno.test("results are validated; an absent resultType means complete", async () => {
  const old = scripted(() => ({ result: { tools: [] } }));
  const client = new McpClient({ transport: old.transport, info: CLIENT_INFO });
  const listed = await client.listTools();
  assertEquals(listed.resultType, "complete");

  const odd = scripted(() => ({ result: { resultType: "later", tools: [] } }));
  assertEquals(
    (await failure(
      new McpClient({ transport: odd.transport, info: CLIENT_INFO })
        .listTools(),
    ))
      .message,
    'unknown resultType "later"',
  );
  // "task" belongs to the tasks extension, and only tools/call may use it.
  const task = scripted(() => ({ result: { resultType: "task", tools: [] } }));
  assertEquals(
    (await failure(
      new McpClient({ transport: task.transport, info: CLIENT_INFO })
        .listTools(),
    ))
      .message,
    "tools/list answered with a task, which only tools/call may",
  );
  const early = scripted(() => ({
    result: { resultType: "input_required", requestState: "x" },
  }));
  assertEquals(
    (await failure(
      new McpClient({ transport: early.transport, info: CLIENT_INFO })
        .listTools(),
    ))
      .kind,
    "decode",
  );
  const broken = scripted(() => ({
    result: { resultType: "complete", tools: [{}] },
  }));
  assertEquals(
    (await failure(
      new McpClient({ transport: broken.transport, info: CLIENT_INFO })
        .listTools(),
    ))
      .message,
    "malformed tools/list result: tools[0].name: is required; tools[0].inputSchema: is required",
  );
});

Deno.test("the MRTR loop answers elicitations and retries", async () => {
  const contexts: unknown[] = [];
  const client = new McpClient({
    transport: inProcessTransport(demoServer()),
    info: CLIENT_INFO,
    handlers: {
      elicitation: (params, context) => {
        contexts.push({
          key: context.key,
          method: context.method,
          name: context.name,
        });
        assertEquals(params.message, "Your GitHub login?");
        return { action: "accept", content: { login: "octocat" } };
      },
    },
  });
  assertEquals(client.capabilities, { elicitation: { form: {} } });
  const result = await client.callTool("login");
  assertEquals(result.content, [{ type: "text", text: "hello octocat" }]);
  assertEquals(contexts, [{
    key: "github",
    method: "tools/call",
    name: "login",
  }]);

  const sloppy = new McpClient({
    transport: inProcessTransport(demoServer()),
    info: CLIENT_INFO,
    handlers: {
      elicitation: () => ({ action: "accept", content: { login: 7 } }),
    },
  });
  assertEquals(
    (await failure(sloppy.callTool("login"))).message,
    "the elicitation handler's answer to github does not match the requested schema: login: expected string, got a number",
  );

  // Without a handler, the client does not declare elicitation, and the
  // server refuses up front.
  const bare = new McpClient({
    transport: inProcessTransport(demoServer()),
    info: CLIENT_INFO,
  });
  const error = await failure(bare.callTool("login"));
  assertEquals([error.kind, error.code], ["rpc", -32021]);
  assertEquals(error.requiredCapabilities, { elicitation: { form: {} } });
});

Deno.test("retries use new ids and echo requestState exactly, or not at all", async () => {
  const { transport, sent } = scripted((_message, index) =>
    index === 0
      ? { result: { resultType: "input_required", requestState: "opaque/+==" } }
      : index === 1
      ? {
        result: {
          resultType: "input_required",
          inputRequests: { r: { method: "roots/list" } },
        },
      }
      : { result: { resultType: "complete", content: [] } }
  );
  const client = new McpClient({
    transport,
    info: CLIENT_INFO,
    handlers: { roots: () => ({ roots: [{ uri: "file:///w" }] }) },
  });
  await client.callTool("x", { a: 1 });
  assertEquals(sent.map((m) => m.id), [1, 2, 3]);
  assertEquals(sent[1].params?.requestState, "opaque/+==");
  assertEquals(sent[1].params?.inputResponses, undefined);
  assertEquals("requestState" in (sent[2].params ?? {}), false);
  assertEquals(sent[2].params?.inputResponses, {
    r: { roots: [{ uri: "file:///w" }] },
  });
  // The original params ride along on every retry.
  assertEquals(sent.map((m) => m.params?.arguments), [{ a: 1 }, { a: 1 }, {
    a: 1,
  }]);
});

Deno.test("unhandled input, bad handler output, and endless rounds are errors", async () => {
  const sampling = scripted(() => ({
    result: {
      resultType: "input_required",
      inputRequests: {
        s: {
          method: "sampling/createMessage",
          params: { messages: [], maxTokens: 1 },
        },
      },
    },
  }));
  const client = new McpClient({
    transport: sampling.transport,
    info: CLIENT_INFO,
  });
  assertEquals((await failure(client.callTool("x"))).kind, "input_unhandled");

  const badHandler = new McpClient({
    transport: sampling.transport,
    info: CLIENT_INFO,
    handlers: {
      sampling: () =>
        ({ role: "assistant", content: { type: "text", text: "4" } }) as never,
    },
  });
  assertEquals(
    (await failure(badHandler.callTool("x"))).message,
    "the sampling/createMessage handler returned model: is required",
  );

  const server = new McpServer({ info: SERVER_INFO, stateSecret: SECRET });
  let runs = 0;
  server.tool({
    name: "again",
    run: (_args, ctx) => {
      runs++;
      return ctx.inputRequired({ state: runs });
    },
  });
  const looping = new McpClient({
    transport: inProcessTransport(server),
    info: CLIENT_INFO,
    maxInputRounds: 3,
  });
  assertEquals((await failure(looping.callTool("again"))).kind, "input_rounds");
  assertEquals(runs, 4);
});

Deno.test("sampling and roots handlers (deprecated) still work", async () => {
  const server = new McpServer({ info: SERVER_INFO, stateSecret: SECRET });
  server.tool({
    name: "both",
    run: (_args, ctx) => {
      const sampled = ctx.sample("s", {
        messages: [{ role: "user", content: { type: "text", text: "2+2?" } }],
        maxTokens: 5,
      });
      const roots = ctx.roots("r");
      return `${
        (sampled.content as { text: string }).text
      } ${roots.roots.length}`;
    },
  });
  const client = new McpClient({
    transport: inProcessTransport(server),
    info: CLIENT_INFO,
    handlers: {
      sampling: () => ({
        role: "assistant",
        content: { type: "text", text: "4" },
        model: "m",
      }),
      roots: () => ({ roots: [{ uri: "file:///a" }, { uri: "file:///b" }] }),
    },
  });
  assertEquals(client.capabilities, { sampling: {}, roots: {} });
  assertEquals((await client.callTool("both")).content, [{
    type: "text",
    text: "4 2",
  }]);
});

Deno.test("x-mcp-header: invalid tools are dropped, arguments become headers", async () => {
  const warnings: string[] = [];
  const bad = scripted(() => ({
    result: {
      resultType: "complete",
      tools: [
        { name: "good", inputSchema: { type: "object" } },
        {
          name: "bad",
          inputSchema: {
            type: "object",
            properties: { n: { type: "number", "x-mcp-header": "N" } },
          },
        },
      ],
    },
  }));
  const listing = new McpClient({
    transport: bad.transport,
    info: CLIENT_INFO,
    onWarning: (message) => warnings.push(message),
  });
  assertEquals((await listing.listTools()).tools.map((tool) => tool.name), [
    "good",
  ]);
  assertEquals(warnings, [
    "dropping tool bad: invalid x-mcp-header: properties.n.type: an x-mcp-header property must be a string, integer or boolean",
  ]);

  const { fetch, headers } = recording(mcpHttpHandler(demoServer()));
  const client = McpClient.http("https://mcp.test/mcp", {
    info: CLIENT_INFO,
    fetch,
  });
  await client.listAllTools();
  const result = await client.callTool("query", {
    region: "日本",
    limit: 3,
    sql: "q",
  });
  assertEquals(result.content, [{ type: "text", text: "日本: q" }]);
  const sent = headers.at(-1)!;
  assertEquals(sent.get("mcp-param-region"), "=?base64?5pel5pys?=");
  assertEquals(sent.get("mcp-param-limit"), "3");
  assertEquals(sent.get("mcp-param-dry"), null);
});

Deno.test("a HeaderMismatch refreshes the tool list and retries once", async () => {
  const { fetch, headers } = recording(mcpHttpHandler(demoServer()));
  const client = McpClient.http("https://mcp.test/mcp", {
    info: CLIENT_INFO,
    fetch,
  });
  // The client has not listed tools, so it cannot know Region is a header.
  const result = await client.callTool("query", { region: "eu", sql: "q" });
  assertEquals(result.content, [{ type: "text", text: "eu: q" }]);
  assertEquals(headers.map((h) => h.get("mcp-method")), [
    "tools/call",
    "tools/list",
    "tools/call",
  ]);
});

Deno.test("a broken stream is re-issued with a new id", async () => {
  const ids: unknown[] = [];
  let calls = 0;
  const fetch: FetchLike = (_input, init) => {
    const body = JSON.parse(String(init?.body));
    ids.push(body.id);
    calls++;
    if (calls === 1) {
      const progress = JSON.stringify({
        jsonrpc: "2.0",
        method: "notifications/progress",
        params: { progressToken: "x", progress: 1 },
      });
      return Promise.resolve(
        new Response(`event: message\ndata: ${progress}\n\n`, {
          headers: { "content-type": "text/event-stream" },
        }),
      );
    }
    return Promise.resolve(Response.json({
      jsonrpc: "2.0",
      id: body.id,
      result: {
        resultType: "complete",
        tools: [],
        ttlMs: 0,
        cacheScope: "public",
      },
    }));
  };
  const client = McpClient.http("https://mcp.test/", {
    info: CLIENT_INFO,
    fetch,
  });
  assertEquals((await client.listTools()).tools, []);
  assertEquals(ids, [1, 2]);

  calls = 0;
  const strict = McpClient.http("https://mcp.test/", {
    info: CLIENT_INFO,
    fetch,
    reissueOnBrokenStream: 0,
  });
  const error = await failure(strict.listTools());
  assertEquals([error.kind, error.message], [
    "stream",
    "the event stream ended without a response",
  ]);
  // A stream cut mid-event is broken too.
  const cut: FetchLike = () =>
    Promise.resolve(
      new Response('event: message\ndata: {"jsonrpc"', {
        headers: { "content-type": "text/event-stream" },
      }),
    );
  assertEquals(
    (await failure(
      McpClient.http("https://mcp.test/", {
        info: CLIENT_INFO,
        fetch: cut,
        reissueOnBrokenStream: 0,
      }).listTools(),
    )).kind,
    "stream",
  );
});

Deno.test("HTTP failures become typed errors", async () => {
  const respond = (response: Response): FetchLike => () =>
    Promise.resolve(response);
  const client = (fetch: FetchLike) =>
    McpClient.http("https://mcp.test/", { info: CLIENT_INFO, fetch });

  const unauthorized = await failure(
    client(respond(
      new Response(null, {
        status: 401,
        headers: {
          "www-authenticate": 'Bearer resource_metadata="https://x/prm"',
        },
      }),
    )).listTools(),
  );
  assertEquals(
    [unauthorized.kind, unauthorized.status, unauthorized.wwwAuthenticate],
    ["unauthorized", 401, 'Bearer resource_metadata="https://x/prm"'],
  );

  const legacy = await failure(
    client(respond(new Response("Not Found", { status: 404 })))
      .listTools(),
  );
  assertEquals([legacy.kind, legacy.status, legacy.data], [
    "http",
    404,
    "Not Found",
  ]);

  const rpc = await failure(
    client(respond(Response.json({
      jsonrpc: "2.0",
      id: 1,
      error: { code: -32020, message: "Header mismatch: x" },
    }, { status: 400 }))).listPrompts(),
  );
  assertEquals([rpc.kind, rpc.code, rpc.status, rpc.method], [
    "rpc",
    -32020,
    400,
    "prompts/list",
  ]);

  const down = await failure(
    client(() => Promise.reject(new TypeError("refused")))
      .listTools(),
  );
  assertEquals([down.kind, down.retryable], ["connection", true]);

  const request = await failure(
    client(() =>
      Promise.resolve(
        new Response(
          'event: message\ndata: {"jsonrpc":"2.0","id":"s1","method":"roots/list"}\n\n',
          { headers: { "content-type": "text/event-stream" } },
        ),
      )
    ).listTools(),
  );
  assertEquals(
    request.message,
    "the server sent a JSON-RPC request, which this revision forbids",
  );
});

Deno.test("missing resources and bad structured output", async () => {
  const client = new McpClient({
    transport: inProcessTransport(demoServer()),
    info: CLIENT_INFO,
  });
  const missing = await failure(client.readResource("file:///missing.txt"));
  assert(missing.resourceNotFound, "resourceNotFound");
  assertEquals(missing.data, { uri: "file:///missing.txt" });

  const liar = scripted((message) =>
    message.method === "tools/list"
      ? {
        result: {
          resultType: "complete",
          tools: [{
            name: "sum",
            inputSchema: { type: "object" },
            outputSchema: {
              type: "object",
              properties: { n: { type: "integer" } },
              required: ["n"],
            },
          }],
        },
      }
      : {
        result: {
          resultType: "complete",
          content: [],
          structuredContent: { n: "x" },
        },
      }
  );
  const checking = new McpClient({
    transport: liar.transport,
    info: CLIENT_INFO,
  });
  await checking.listTools();
  assertEquals(
    (await failure(checking.callTool("sum"))).message,
    "tool sum returned output that fails its outputSchema: n: expected integer, got a string",
  );
  const trusting = new McpClient({
    transport: liar.transport,
    info: CLIENT_INFO,
    validateToolOutput: false,
  });
  await trusting.listTools();
  assertEquals((await trusting.callTool("sum")).structuredContent, { n: "x" });
});

Deno.test("prompts, resources, templates and completion through the client", async () => {
  const client = McpClient.http("https://mcp.test/mcp", {
    info: CLIENT_INFO,
    fetch: handlerFetch(mcpHttpHandler(demoServer(), { path: "/mcp" })),
  });
  assertEquals((await client.listPrompts()).prompts.map((p) => p.name), [
    "greet",
  ]);
  assertEquals(
    (await client.getPrompt("greet", { name: "Ada" })).messages[0].content,
    { type: "text", text: "Greet Ada." },
  );
  assertEquals((await client.listResources()).resources.map((r) => r.uri), [
    "config://app",
  ]);
  assertEquals(
    (await client.listResourceTemplates()).resourceTemplates.map((t) =>
      t.uriTemplate
    ),
    ["file:///{+path}"],
  );
  assertEquals((await client.readResource("config://app")).contents[0], {
    uri: "config://app",
    text: '{"debug":true}',
    mimeType: "application/json",
  });
  assertEquals(
    (await client.complete({
      ref: { type: "ref/prompt", name: "greet" },
      argument: { name: "name", value: "b" },
    })).completion.values,
    ["bob"],
  );
  const discovered = await client.discover();
  assertEquals(discovered._meta?.[META.serverInfo], SERVER_INFO);
  assertEquals(
    (await client.request("server/discover")).resultType,
    "complete",
  );
});

/** A router auth scheme reading `X-Platform-Token`, with a Bearer challenge. */
function platformAuth(
  check: (token: string | null) => AuthOutcome,
): AuthScheme {
  return {
    name: "platform",
    authenticate: (c) => check(c.req.headers.get("x-platform-token")),
    challenge: (error) => ({ scheme: "Bearer", params: errorParams(error) }),
  };
}

Deno.test("an HttpAuthProvider supplies headers and answers challenges", async () => {
  const server = demoServer();
  let accepted = "";
  const handler = mcpHttpHandler(server, {
    auth: platformAuth((token) =>
      token === accepted && accepted !== ""
        ? { subject: "platform-user" }
        : new AuthError("invalid_token", "")
    ),
  });
  const challenges: {
    status: number;
    attempt: number;
    header: string | null;
  }[] = [];
  let token = "stale";
  const client = McpClient.http("https://mcp.test/mcp", {
    info: CLIENT_INFO,
    fetch: handlerFetch(handler),
    headers: { "x-platform-token": "overridden" },
    auth: {
      headers: () => ({ "x-platform-token": token }),
      challenge(challenge) {
        challenges.push({
          status: challenge.status,
          attempt: challenge.attempt,
          header: challenge.headers.get("www-authenticate"),
        });
        accepted = "fresh";
        token = "fresh";
        return Promise.resolve(true);
      },
    },
  });
  await client.callTool("echo", { text: "hi" });
  assertEquals(challenges, [{
    status: 401,
    attempt: 1,
    header: 'Bearer error="invalid_token"',
  }]);

  // Giving up, or failing, is `unauthorized`; a failure is the cause.
  const refusing = McpClient.http("https://mcp.test/mcp", {
    info: CLIENT_INFO,
    fetch: handlerFetch(mcpHttpHandler(server, {
      auth: platformAuth(() => new AuthError("insufficient_scope", "")),
    })),
    auth: {
      headers: () => ({}),
      challenge: (challenge) =>
        challenge.attempt === 1
          ? Promise.resolve(true)
          : Promise.reject(Object.assign(new Error("no way"), {
            toJSON: () => ({ kind: "custom" }),
          })),
    },
  });
  const error = await failure(refusing.callTool("echo", { text: "hi" }));
  assertEquals([error.kind, error.status], ["unauthorized", 403]);
  assertEquals((error.cause as Error).message, "no way");
  assertEquals(error.data, { kind: "custom" });

  // The number of challenges per request is bounded.
  let asked = 0;
  const looping = McpClient.http("https://mcp.test/mcp", {
    info: CLIENT_INFO,
    fetch: handlerFetch(mcpHttpHandler(server, {
      auth: platformAuth(() => null),
    })),
    maxAuthAttempts: 2,
    auth: {
      headers: () => ({}),
      challenge: () => {
        asked++;
        return Promise.resolve(true);
      },
    },
  });
  assertEquals(
    (await failure(looping.callTool("echo", { text: "x" }))).kind,
    "unauthorized",
  );
  assertEquals(asked, 2);
});

// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

import { assert, assertEquals, assertThrows } from "@celld/assert";
import {
  compileUriTemplate,
  McpServer,
  META,
  type Principal,
} from "@celld/mcp";
import { testPrincipal } from "@celld/mcp/testing";
import { v } from "@celld/sieve";
import {
  demoServer,
  errorOf,
  request,
  resultOf,
  SERVER_INFO,
} from "./fixture.ts";

Deno.test("server/discover advertises versions, capabilities and identity", async () => {
  const result = resultOf(
    await demoServer().handle(request("server/discover")),
  );
  assertEquals(result, {
    supportedVersions: ["2026-07-28"],
    capabilities: {
      tools: { listChanged: false },
      prompts: { listChanged: false },
      resources: { listChanged: false, subscribe: false },
      completions: {},
    },
    ttlMs: 60000,
    cacheScope: "private",
    instructions: "Test server.",
    resultType: "complete",
    _meta: { [META.serverInfo]: SERVER_INFO },
  });
});

Deno.test("an unsupported version is refused with the supported list", async () => {
  const response = await demoServer().handle(
    request("tools/list", {}, {
      meta: { [META.protocolVersion]: "1900-01-01" },
    }),
  );
  assertEquals(errorOf(response), {
    code: -32022,
    message: "Unsupported protocol version",
    data: { supported: ["2026-07-28"], requested: "1900-01-01" },
  });
});

Deno.test("a request without the required _meta is invalid params", async () => {
  const response = await demoServer().handle({
    jsonrpc: "2.0",
    id: 1,
    method: "tools/list",
    params: {},
  });
  const error = errorOf(response);
  assertEquals(error.code, -32602);
  assertEquals(
    error.message,
    "Invalid request metadata: params._meta: is required",
  );
});

Deno.test("unknown methods, and features the server lacks, are not found", async () => {
  const bare = new McpServer({ info: SERVER_INFO });
  assertEquals(
    errorOf(await bare.handle(request("prompts/list"))).code,
    -32601,
  );
  assertEquals(
    errorOf(await bare.handle(request("tools/call", { name: "x" }))).code,
    -32601,
  );
  assertEquals(errorOf(await demoServer().handle(request("ping"))), {
    code: -32601,
    message: "Method not found: ping",
    data: { method: "ping" },
  });
  // Removed methods of earlier revisions are just unknown.
  assertEquals(
    errorOf(await demoServer().handle(request("initialize"))).code,
    -32601,
  );
  assertEquals(
    errorOf(await demoServer().handle(request("logging/setLevel"))).code,
    -32601,
  );
});

Deno.test("params are validated per method", async () => {
  const error = errorOf(
    await demoServer().handle(request("tools/call", { name: 7 })),
  );
  assertEquals(error, {
    code: -32602,
    message: "Invalid params: params.name: expected a string, got a number",
  });
  assertEquals(
    errorOf(
      await demoServer().handle(
        request("prompts/get", { name: "greet", arguments: { name: 1 } }),
      ),
    )
      .message,
    "Invalid params: params.arguments.name: expected a string, got a number",
  );
});

Deno.test("tools/list is sorted, cacheable and paginated", async () => {
  const server = demoServer({
    pageSize: 2,
    cache: { ttlMs: 300000, scope: "public" },
  });
  const names: string[] = [];
  let cursor: string | undefined;
  let pages = 0;
  do {
    const result = resultOf(
      await server.handle(
        request("tools/list", cursor === undefined ? {} : { cursor }),
      ),
    );
    assertEquals([result.ttlMs, result.cacheScope], [300000, "public"]);
    names.push(
      ...(result.tools as { name: string }[]).map((tool) => tool.name),
    );
    cursor = result.nextCursor as string | undefined;
    pages++;
  } while (cursor !== undefined);
  assertEquals(names, ["add", "echo", "fail", "login", "query"]);
  assertEquals(pages, 3);
  assertEquals(
    errorOf(await server.handle(request("tools/list", { cursor: "garbage" }))),
    { code: -32602, message: "Invalid cursor", data: { cursor: "garbage" } },
  );
});

Deno.test("tool definitions carry their schemas", async () => {
  const result = resultOf(await demoServer().handle(request("tools/list")));
  const tools = result.tools as Record<string, unknown>[];
  assertEquals(tools.find((tool) => tool.name === "add"), {
    name: "add",
    inputSchema: {
      type: "object",
      properties: { a: { type: "integer" }, b: { type: "integer" } },
      required: ["a", "b"],
      additionalProperties: false,
    },
    outputSchema: {
      type: "object",
      properties: { sum: { type: "integer" } },
      required: ["sum"],
      additionalProperties: false,
    },
  });
  // No input schema means no arguments, as the spec recommends.
  assertEquals(
    tools.find((tool) => tool.name === "login")?.inputSchema,
    { type: "object", additionalProperties: false },
  );
});

Deno.test("tools/call returns text, structured content, and tool errors", async () => {
  const server = demoServer();
  assertEquals(
    resultOf(
      await server.handle(
        request("tools/call", { name: "echo", arguments: { text: "hi" } }),
      ),
    ),
    {
      content: [{ type: "text", text: "hi" }],
      resultType: "complete",
      _meta: { [META.serverInfo]: SERVER_INFO },
    },
  );
  const sum = resultOf(
    await server.handle(
      request("tools/call", { name: "add", arguments: { a: 2, b: 3 } }),
    ),
  );
  assertEquals(sum.structuredContent, { sum: 5 });
  // Structured content is also serialised into a text block.
  assertEquals(sum.content, [{ type: "text", text: '{"sum":5}' }]);

  const invalid = resultOf(
    await server.handle(
      request("tools/call", { name: "add", arguments: { a: "2" } }),
    ),
  );
  assertEquals(invalid.isError, true);
  assertEquals(invalid.content, [{
    type: "text",
    text:
      "Invalid arguments for add: a: expected number, received string; b: missing required key",
  }]);

  const failed = resultOf(
    await server.handle(
      request("tools/call", { name: "fail", arguments: { how: "tool" } }),
    ),
  );
  assertEquals([failed.isError, failed.content], [true, [{
    type: "text",
    text: "the tool failed on purpose",
  }]]);
});

Deno.test("an unexpected tool crash is reported, not leaked", async () => {
  const reported: unknown[] = [];
  const server = demoServer({ onError: (error) => reported.push(error) });
  const result = resultOf(
    await server.handle(
      request("tools/call", { name: "fail", arguments: { how: "crash" } }),
    ),
  );
  assertEquals(result.content, [{ type: "text", text: "Tool fail failed" }]);
  assertEquals(result.isError, true);
  assertEquals((reported[0] as Error).message, "secret internal detail");
  // An McpError thrown by a tool is a protocol error.
  assertEquals(
    errorOf(
      await server.handle(
        request("tools/call", { name: "fail", arguments: { how: "rpc" } }),
      ),
    ),
    { code: -32602, message: "rpc failure on purpose" },
  );
});

Deno.test("unknown tools and bad structured output are protocol errors", async () => {
  const reported: unknown[] = [];
  const server = demoServer({ onError: (error) => reported.push(error) });
  assertEquals(
    errorOf(await server.handle(request("tools/call", { name: "nope" }))),
    { code: -32602, message: "Unknown tool: nope", data: { name: "nope" } },
  );
  server.tool({
    name: "liar",
    output: v.strictObject({ n: v.int() }),
    run: () => ({ structuredContent: { n: "one" } }),
  });
  assertEquals(
    errorOf(await server.handle(request("tools/call", { name: "liar" }))),
    { code: -32603, message: "Internal error" },
  );
  assertEquals(
    (reported[0] as Error).message,
    "tool liar returned structuredContent that fails its outputSchema: n: expected number, received string",
  );
});

Deno.test("visibility and required capabilities are per request", async () => {
  const server = new McpServer({ info: SERVER_INFO });
  server.tool({
    name: "admin",
    visible: (info) => info.principal?.scopes?.includes("admin") ?? false,
    run: () => "ok",
  });
  server.tool({
    name: "needs-url",
    requires: { elicitation: { url: {} } },
    run: () => "ok",
  });
  const admin: Principal = testPrincipal("a", { scopes: ["admin"] });
  const list = async (principal: Principal | null) =>
    (resultOf(await server.handle(request("tools/list"), { principal }))
      .tools as {
        name: string;
      }[]).map((tool) => tool.name);
  assertEquals(await list(null), ["needs-url"]);
  assertEquals(await list(admin), ["admin", "needs-url"]);
  assertEquals(
    errorOf(await server.handle(request("tools/call", { name: "admin" }))).code,
    -32602,
  );
  assertEquals(
    errorOf(await server.handle(request("tools/call", { name: "needs-url" }))),
    {
      code: -32021,
      message: "Missing required client capability: elicitation",
      data: { requiredCapabilities: { elicitation: { url: {} } } },
    },
  );
  assertEquals(
    resultOf(
      await server.handle(
        request("tools/call", { name: "needs-url" }, {
          capabilities: { elicitation: { url: {} } },
        }),
      ),
    ).content,
    [{ type: "text", text: "ok" }],
  );
});

Deno.test("prompts: list, get, and missing arguments", async () => {
  const server = demoServer();
  const list = resultOf(await server.handle(request("prompts/list")));
  assertEquals(list.prompts, [{
    name: "greet",
    description: "Greets someone.",
    arguments: [{ name: "name", required: true }, { name: "tone" }],
  }]);
  const got = resultOf(
    await server.handle(
      request("prompts/get", {
        name: "greet",
        arguments: { name: "Ada", tone: "warm" },
      }),
    ),
  );
  assertEquals(got.messages, [{
    role: "user",
    content: { type: "text", text: "Greet Ada warmly." },
  }]);
  assertEquals(
    errorOf(await server.handle(request("prompts/get", { name: "greet" }))),
    {
      code: -32602,
      message: "Missing required argument: name",
      data: { name: "greet", argument: "name" },
    },
  );
  assertEquals(
    errorOf(await server.handle(request("prompts/get", { name: "nope" }))).code,
    -32602,
  );
});

Deno.test("resources: fixed, templated, binary and missing", async () => {
  const server = demoServer();
  assertEquals(
    resultOf(await server.handle(request("resources/list"))).resources,
    [{ uri: "config://app", name: "config", mimeType: "application/json" }],
  );
  assertEquals(
    resultOf(await server.handle(request("resources/templates/list")))
      .resourceTemplates,
    [{ uriTemplate: "file:///{+path}", name: "files" }],
  );
  const config = resultOf(
    await server.handle(request("resources/read", { uri: "config://app" })),
  );
  assertEquals(config.contents, [{
    uri: "config://app",
    text: '{"debug":true}',
    mimeType: "application/json",
  }]);
  assertEquals([config.ttlMs, config.cacheScope], [5000, "public"]);
  const file = resultOf(
    await server.handle(
      request("resources/read", { uri: "file:///dir/a%20b.txt" }),
    ),
  );
  assertEquals(file.contents, [{
    uri: "file:///dir/a%20b.txt",
    mimeType: "text/plain",
    text: "contents of dir/a b.txt",
  }]);
  const blob = resultOf(
    await server.handle(request("resources/read", { uri: "file:///x.bin" })),
  );
  assertEquals(blob.contents, [{ uri: "file:///x.bin", blob: "AAEC/w==" }]);
  // Not found is -32602 with the URI, never -32002 or empty contents.
  assertEquals(
    errorOf(
      await server.handle(
        request("resources/read", { uri: "file:///missing.txt" }),
      ),
    ),
    {
      code: -32602,
      message: "Resource not found",
      data: { uri: "file:///missing.txt" },
    },
  );
  assertEquals(
    errorOf(await server.handle(request("resources/read", { uri: "nope://x" })))
      .code,
    -32602,
  );
});

Deno.test("completion for prompt arguments and template variables", async () => {
  const server = demoServer();
  const prompt = resultOf(
    await server.handle(request("completion/complete", {
      ref: { type: "ref/prompt", name: "greet" },
      argument: { name: "name", value: "al" },
    })),
  );
  assertEquals(prompt.completion, { values: ["alice", "albert"], total: 2 });
  const template = resultOf(
    await server.handle(request("completion/complete", {
      ref: { type: "ref/resource", uri: "file:///{+path}" },
      argument: { name: "path", value: "b" },
    })),
  );
  assertEquals(template.completion, { values: ["b.txt"], total: 1 });
  const none = resultOf(
    await server.handle(request("completion/complete", {
      ref: { type: "ref/prompt", name: "greet" },
      argument: { name: "tone", value: "" },
    })),
  );
  assertEquals(none.completion, { values: [], total: 0 });
  assertEquals(
    errorOf(
      await server.handle(request("completion/complete", {
        ref: { type: "ref/prompt", name: "nope" },
        argument: { name: "x", value: "" },
      })),
    ).code,
    -32602,
  );
  const many = new McpServer({ info: SERVER_INFO });
  many.prompt({
    name: "p",
    complete: { x: () => Array.from({ length: 150 }, (_, i) => `v${i}`) },
    get: () => [],
  });
  const capped = resultOf(
    await many.handle(request("completion/complete", {
      ref: { type: "ref/prompt", name: "p" },
      argument: { name: "x", value: "" },
    })),
  );
  const completion = capped.completion as {
    values: string[];
    total: number;
    hasMore: boolean;
  };
  assertEquals(
    [completion.values.length, completion.total, completion.hasMore],
    [100, 150, true],
  );
});

Deno.test("registration refuses what it could not serve correctly", () => {
  const server = new McpServer({ info: SERVER_INFO });
  assertEquals(
    assertThrows(() => server.tool({ name: "has space", run: () => "" }))
      .message,
    'tool name "has space" must be 1-128 of A-Z a-z 0-9 _ - .',
  );
  server.tool({ name: "t", run: () => "" });
  assertEquals(
    assertThrows(() => server.tool({ name: "t", run: () => "" })).message,
    "duplicate tool t",
  );
  assertEquals(
    assertThrows(() =>
      server.tool({ name: "u", input: { type: "string" }, run: () => "" })
    ).message,
    'tool u: inputSchema must have type "object"',
  );
  assertEquals(
    assertThrows(() =>
      server.tool({
        name: "v",
        input: {
          type: "object",
          properties: { n: { type: "number", "x-mcp-header": "N" } },
        },
        run: () => "",
      })
    ).message,
    "tool v: invalid x-mcp-header: properties.n.type: an x-mcp-header property must be a string, integer or boolean",
  );
  assert(
    assertThrows(() =>
      server.tool({
        name: "w",
        input: {
          type: "object",
          $schema: "http://json-schema.org/draft-07/schema#",
        },
        run: () => "",
      })
    ).message.startsWith(
      "tool w: invalid JSON Schema: /$schema: unsupported dialect",
    ),
    "dialect",
  );
  assertEquals(
    assertThrows(() => compileUriTemplate("file:///{?query}")).message,
    "unsupported URI template expression {?query}: only {var} and {+var}",
  );
  const simple = compileUriTemplate("users/{id}/posts/{+rest}");
  assertEquals(simple.variables, ["id", "rest"]);
  assert(simple.pattern.test("users/7/posts/a/b"), "matches");
  assert(!simple.pattern.test("users/7/8/posts/a"), "{var} does not cross /");
});

// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

import {
  assert,
  assertEquals,
  assertRejects,
  assertThrows,
} from "@celld/core/assert";
import {
  argumentAt,
  decodeHeaderValue,
  encodeHeaderValue,
  httpTransport,
  type HttpTransportOptions,
  McpError,
  paramHeaderMismatch,
  paramHeaders,
  paramHeaderValue,
} from "@celld/mcp";

const ping = { jsonrpc: "2.0" as const, id: 1, method: "ping" };
const requestOptions = () => ({
  signal: new AbortController().signal,
  onNotification: () => {},
  headers: {},
});
const pong = () => Response.json({ jsonrpc: "2.0", id: 1, result: {} });

Deno.test("Daybreak HTTP transport strictly checks options before invoking getters", () => {
  for (
    const options of [
      null,
      [],
      { maxAuthAttemps: 1 },
      { maxAuthAttempts: null },
      { maxResponseBytes: null },
      { maxStreamBytes: "1024" },
      { allowLoopbackForDevelopment: "true" },
      { fetch: null },
      { headers: null },
      { headers: { Authorization: 1 } },
      { headers: { Authorization: "a", authorization: "b" } },
      { headers: { authorization: "secret\r\ninjected: value" } },
      { headers: { "x-large": "x".repeat(16385) } },
      { auth: null },
      { auth: {} },
      { auth: { headers: () => ({}) } },
    ]
  ) {
    assertThrows(
      () => httpTransport("https://mcp.test/mcp", options as never),
      TypeError,
    );
  }
  let getterCalls = 0;
  for (
    const options of [
      {
        get allowLoopbackForDevelopment() {
          getterCalls++;
          return true;
        },
      },
      {
        headers: {
          get authorization() {
            getterCalls++;
            return "Bearer secret";
          },
        },
      },
      {
        auth: {
          get headers() {
            getterCalls++;
            return () => ({});
          },
        },
      },
    ]
  ) {
    assertThrows(
      () => httpTransport("https://mcp.test/mcp", options as never),
      TypeError,
    );
  }
  assertEquals(getterCalls, 0);
  for (
    const url of [
      { toString: () => "https://mcp.test" },
      " https://mcp.test",
      "https://mcp.test/\\evil",
    ]
  ) {
    assertThrows(() => httpTransport(url as never), TypeError);
  }
  assertEquals(
    httpTransport("https://MCP.TEST:443/mcp").endpoint,
    "https://mcp.test/mcp",
  );
});

Deno.test("Daybreak HTTP transport captures options and stateful provider methods", async () => {
  class Provider {
    #token = "Bearer original";
    headers() {
      return { authorization: this.#token };
    }
    challenge() {
      return Promise.resolve(false);
    }
  }
  const auth = new Provider();
  const options: {
    -readonly [K in keyof HttpTransportOptions]: HttpTransportOptions[K];
  } = {
    headers: () => ({ "x-extra": "original" }),
    auth,
    fetch: (_url, init) => {
      const sent = new Headers(init?.headers);
      assertEquals(sent.get("authorization"), "Bearer original");
      assertEquals(sent.get("x-extra"), "original");
      return Promise.resolve(pong());
    },
  };
  const transport = httpTransport("https://mcp.test/mcp", options);
  options.headers = () => ({ "x-extra": "changed" });
  options.fetch = () => {
    throw new Error("replacement fetch called");
  };
  auth.headers = () => ({ authorization: "Bearer changed" });
  await transport.request(ping, requestOptions());
  assert(Object.isFrozen(transport), "transport capabilities are frozen");

  const headers = { "x-extra": "original" };
  const staticTransport = httpTransport("https://mcp.test/mcp", {
    headers,
    fetch: (_url, init) => {
      assertEquals(new Headers(init?.headers).get("x-extra"), "original");
      return Promise.resolve(pong());
    },
  });
  headers["x-extra"] = "changed";
  await staticTransport.request(ping, requestOptions());
});

Deno.test("Daybreak HTTP transport refuses malformed dynamic credentials before sending", async () => {
  let fetched = 0;
  for (const via of ["headers", "auth"] as const) {
    const bad = () => ({ Authorization: "a", authorization: "b" });
    const transport = httpTransport("https://mcp.test/mcp", {
      ...(via === "headers" ? { headers: bad } : {
        auth: { headers: bad, challenge: () => Promise.resolve(false) },
      }),
      fetch: () => {
        fetched++;
        return Promise.resolve(pong());
      },
    });
    await assertRejects(
      () => transport.request(ping, requestOptions()),
      TypeError,
    );
  }
  assertEquals(fetched, 0);
});

Deno.test("Daybreak HTTP transport does not fetch after an awaited credential callback aborts", async () => {
  for (const via of ["headers", "auth"] as const) {
    const controller = new AbortController();
    let fetched = false;
    const abort = () => {
      controller.abort();
      return Promise.resolve({});
    };
    const transport = httpTransport("https://mcp.test/mcp", {
      ...(via === "headers" ? { headers: abort } : {
        auth: { headers: abort, challenge: () => Promise.resolve(false) },
      }),
      fetch: () => {
        fetched = true;
        return Promise.resolve(pong());
      },
    });
    const error = await assertRejects(() =>
      transport.request(ping, {
        ...requestOptions(),
        signal: controller.signal,
      }), McpError);
    assertEquals(error.kind, "aborted");
    assertEquals(fetched, false);
  }
});

Deno.test("Daybreak HTTP transport cancels a response returned after abort", async () => {
  const controller = new AbortController();
  let cancelled = false;
  let observed = false;
  const transport = httpTransport("https://mcp.test/mcp", {
    auth: {
      headers: () => ({}),
      challenge: () => Promise.resolve(false),
      observe: () => {
        observed = true;
      },
    },
    fetch: () => {
      controller.abort();
      return Promise.resolve(
        new Response(
          new ReadableStream({
            cancel() {
              cancelled = true;
            },
          }),
        ),
      );
    },
  });
  const error = await assertRejects(() =>
    transport.request(ping, {
      ...requestOptions(),
      signal: controller.signal,
    }), McpError);
  assertEquals(error.kind, "aborted");
  assertEquals(cancelled, true);
  assertEquals(observed, false);
});

Deno.test("Daybreak auth context describes the exact credentials sent despite header casing", async () => {
  const authContext = Object.freeze({
    authorization: "Bearer current",
    "x-api-key": "current-key",
  });
  let observed = false;
  const transport = httpTransport("https://mcp.test/mcp", {
    headers: { Authorization: "Bearer stale", "X-API-Key": "stale-key" },
    auth: {
      headers: () => Promise.resolve(authContext),
      challenge: () => Promise.resolve(false),
      observe(response) {
        assert(
          response.authContext === authContext,
          "the exact context is propagated",
        );
        observed = true;
      },
    },
    fetch: (_input, init) => {
      const sent = new Headers(init?.headers);
      assertEquals(sent.get("authorization"), "Bearer current");
      assertEquals(sent.get("x-api-key"), "current-key");
      return Promise.resolve(
        Response.json({ jsonrpc: "2.0", id: 1, result: {} }),
      );
    },
  });
  await transport.request({ jsonrpc: "2.0", id: 1, method: "ping" }, {
    signal: new AbortController().signal,
    onNotification: () => {},
    headers: { AUTHORIZATION: "Bearer injected" },
  });
  assertEquals(observed, true);
});

Deno.test("header values encode as the spec's table shows", () => {
  assertEquals(encodeHeaderValue("us-west1"), "us-west1");
  assertEquals(
    encodeHeaderValue("Hello, 世界"),
    "=?base64?SGVsbG8sIOS4lueVjA==?=",
  );
  assertEquals(encodeHeaderValue(" padded "), "=?base64?IHBhZGRlZCA=?=");
  assertEquals(
    encodeHeaderValue("line1\nline2"),
    "=?base64?bGluZTEKbGluZTI=?=",
  );
  assertEquals(
    encodeHeaderValue("=?base64?literal?="),
    "=?base64?PT9iYXNlNjQ/bGl0ZXJhbD89?=",
  );
  assertEquals(encodeHeaderValue("a\tb"), "a\tb");
});

Deno.test("header values decode, and bad ones are refused", () => {
  for (
    const value of [
      "us-west1",
      "Hello, 世界",
      " padded ",
      "line1\nline2",
      "=?base64?literal?=",
    ]
  ) {
    assertEquals(decodeHeaderValue(encodeHeaderValue(value)), value);
  }
  assertEquals(decodeHeaderValue("=?base64?not base64!?="), null);
  // Valid base64, invalid UTF-8.
  assertEquals(decodeHeaderValue("=?base64?/w==?="), null);
  assertEquals(decodeHeaderValue("café"), null);
  assertEquals(decodeHeaderValue("a\u0001b"), null);
  // The markers are case-sensitive: this is a plain value.
  assertEquals(decodeHeaderValue("=?BASE64?eA==?="), "=?BASE64?eA==?=");
});

Deno.test("x-mcp-header annotations are found through properties chains", () => {
  const found = paramHeaders({
    type: "object",
    properties: {
      region: { type: "string", "x-mcp-header": "Region" },
      options: {
        type: "object",
        properties: { tenant: { type: "integer", "x-mcp-header": "Tenant" } },
      },
      flag: { type: ["boolean", "null"], "x-mcp-header": "Flag" },
      query: { type: "string" },
    },
  });
  assertEquals(found.issues, []);
  assertEquals(found.headers, [
    { name: "Region", path: ["region"] },
    { name: "Tenant", path: ["options", "tenant"] },
    { name: "Flag", path: ["flag"] },
  ]);
});

Deno.test("x-mcp-header constraints are enforced", () => {
  const messages = (schema: unknown) =>
    paramHeaders(schema).issues.map((issue) => issue.message);
  assertEquals(
    messages({
      type: "object",
      properties: { a: { type: "string", "x-mcp-header": "" } },
    }),
    ["must be a non-empty HTTP token"],
  );
  assertEquals(
    messages({
      type: "object",
      properties: { a: { type: "string", "x-mcp-header": "Bad Name" } },
    }),
    ["must be a non-empty HTTP token"],
  );
  assertEquals(
    messages({
      type: "object",
      properties: {
        a: { type: "string", "x-mcp-header": "Same" },
        b: { type: "string", "x-mcp-header": "same" },
      },
    }),
    ["duplicates the header name same"],
  );
  assertEquals(
    messages({
      type: "object",
      properties: { a: { type: "number", "x-mcp-header": "N" } },
    }),
    ["an x-mcp-header property must be a string, integer or boolean"],
  );
  assertEquals(
    messages({
      type: "object",
      properties: {
        a: { type: "array", items: { type: "string", "x-mcp-header": "I" } },
      },
    }),
    ["is only allowed on properties reachable through properties keys"],
  );
  assertEquals(
    messages({
      type: "object",
      anyOf: [{ properties: { a: { type: "string", "x-mcp-header": "A" } } }],
    }),
    ["is only allowed on properties reachable through properties keys"],
  );
  assertEquals(
    messages({
      type: "object",
      $defs: { x: { type: "string", "x-mcp-header": "X" } },
      properties: { a: { $ref: "#/$defs/x" } },
    }),
    ["is only allowed on properties reachable through properties keys"],
  );
});

Deno.test("argument values become header values", () => {
  assertEquals(paramHeaderValue("us-west1"), "us-west1");
  assertEquals(paramHeaderValue(42), "42");
  assertEquals(paramHeaderValue(-7), "-7");
  assertEquals(paramHeaderValue(true), "true");
  assertEquals(paramHeaderValue(null), null);
  assertEquals(paramHeaderValue(undefined), null);
  for (const bad of [1.5, 2 ** 53, {}, []]) {
    let threw = false;
    try {
      paramHeaderValue(bad);
    } catch {
      threw = true;
    }
    assert(threw, JSON.stringify(bad));
  }
  assertEquals(argumentAt({ a: { b: 1 } }, ["a", "b"]), 1);
  assertEquals(argumentAt({ a: 1 }, ["a", "b"]), undefined);
});

Deno.test("servers compare headers to arguments", () => {
  const headers = [
    { name: "Region", path: ["region"] },
    { name: "Limit", path: ["limit"] },
    { name: "Dry", path: ["dry"] },
  ];
  const get = (map: Record<string, string>) => (name: string) =>
    Object.entries(map).find(([key]) =>
      key.toLowerCase() === name.toLowerCase()
    )
      ?.[1] ?? null;
  assertEquals(
    paramHeaderMismatch(
      headers,
      { region: "eu", limit: 42, dry: false },
      get({
        "Mcp-Param-Region": "eu",
        "mcp-param-limit": "42.0",
        "Mcp-Param-Dry": "false",
      }),
    ),
    null,
  );
  assertEquals(
    paramHeaderMismatch(headers, { region: "eu" }, get({})),
    "Mcp-Param-Region is missing",
  );
  assertEquals(
    paramHeaderMismatch(
      headers,
      { region: "eu" },
      get({ "Mcp-Param-Region": "us" }),
    ),
    'Mcp-Param-Region header value "us" does not match body value "eu"',
  );
  assertEquals(
    paramHeaderMismatch(
      headers,
      { region: "eu", limit: null },
      get({
        "Mcp-Param-Region": "eu",
        "Mcp-Param-Limit": "1",
      }),
    ),
    "Mcp-Param-Limit is present but the argument is absent",
  );
  assertEquals(
    paramHeaderMismatch(
      headers,
      { region: "世界" },
      get({
        "Mcp-Param-Region": encodeHeaderValue("世界"),
      }),
    ),
    null,
  );
  assertEquals(
    paramHeaderMismatch(
      headers,
      { region: "eu", limit: 42 },
      get({
        "Mcp-Param-Region": "eu",
        "Mcp-Param-Limit": "4.2e1",
      }),
    ),
    'Mcp-Param-Limit header value "4.2e1" does not match body value 42',
  );
});

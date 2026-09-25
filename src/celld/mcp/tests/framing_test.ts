// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

import { assert, assertEquals } from "@celld/assert";
import {
  attempt,
  check,
  frame,
  HEADER_MISMATCH,
  inputRequiredResult,
  isMcpError,
  isReservedMetaKey,
  isTraceparent,
  isValidMetaKey,
  LEGACY_RESOURCE_NOT_FOUND,
  McpError,
  mcpErrorFromData,
  META,
  MISSING_REQUIRED_CLIENT_CAPABILITY,
  parseJson,
  requestMeta,
  RESULT,
  UNSUPPORTED_PROTOCOL_VERSION,
} from "@celld/mcp";
import { meta } from "./fixture.ts";

function rejects(value: unknown): McpError {
  try {
    frame(value);
  } catch (error) {
    assert(isMcpError(error), `not an McpError: ${error}`);
    return error;
  }
  throw new Error(`accepted ${JSON.stringify(value)}`);
}

Deno.test("requests, notifications and responses are told apart", () => {
  assertEquals(
    frame({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }).type,
    "request",
  );
  assertEquals(frame({ jsonrpc: "2.0", id: "a", method: "x" }).type, "request");
  assertEquals(
    frame({ jsonrpc: "2.0", method: "notifications/cancelled" }).type,
    "notification",
  );
  assertEquals(
    frame({ jsonrpc: "2.0", id: 1, result: { resultType: "complete" } }).type,
    "response",
  );
  assertEquals(
    frame({ jsonrpc: "2.0", error: { code: -32700, message: "Parse error" } })
      .type,
    "response",
  );
});

Deno.test("framing is strict and says what is wrong", () => {
  assertEquals(
    rejects([{ jsonrpc: "2.0", id: 1, method: "x" }]).message,
    "Invalid request: batches are not supported",
  );
  assertEquals(rejects("hi").code, -32600);
  assertEquals(
    rejects({ jsonrpc: "1.0", id: 1, method: "x" }).message,
    'Invalid request: jsonrpc: expected "2.0", got "1.0"',
  );
  assertEquals(
    rejects({ jsonrpc: "2.0", id: null, method: "x" }).message,
    "Invalid request: id: expected a string or integer id, got null",
  );
  assertEquals(
    rejects({ jsonrpc: "2.0", id: 1.5, method: "x" }).message,
    "Invalid request: id: expected a string or integer id, got a number",
  );
  assertEquals(
    rejects({ jsonrpc: "2.0", id: 1, method: "x", params: [1] }).message,
    "Invalid request: params: expected an object, got an array",
  );
  assertEquals(
    rejects({
      jsonrpc: "2.0",
      id: 1,
      result: {},
      error: { code: 1, message: "" },
    })
      .message,
    "Invalid request: (root): needs a method, or exactly one of result and error",
  );
  assertEquals(
    rejects({ jsonrpc: "2.0", id: 1, error: { code: 1.5, message: "x" } })
      .message,
    "Invalid request: error.code: expected an integer, got a number",
  );
});

Deno.test("non-JSON is a parse error", () => {
  let caught: unknown;
  try {
    parseJson("{nope");
  } catch (error) {
    caught = error;
  }
  assert(caught instanceof McpError, "an McpError");
  assertEquals((caught as McpError).toRpcError(), {
    code: -32700,
    message: "Parse error",
  });
});

Deno.test("request _meta needs the version and capabilities", () => {
  assertEquals(check(meta(), requestMeta), []);
  const missing = check({ [META.clientCapabilities]: {} }, requestMeta);
  assertEquals(missing, [{
    path: [META.protocolVersion],
    message: "is required",
  }]);
  assertEquals(
    check({ [META.protocolVersion]: "2026-07-28" }, requestMeta).map((i) =>
      i.message
    ),
    ["is required"],
  );
  assertEquals(
    check(meta({ [META.logLevel]: "verbose" }), requestMeta)[0].message,
    "is not a log level",
  );
  assertEquals(
    check(meta({ "bad key!": 1 }), requestMeta)[0].message,
    "is not a valid _meta key",
  );
  assertEquals(
    check(meta({ [META.progressToken]: 1.5 }), requestMeta)[0].message,
    "expected a string or integer token, got a number",
  );
  assertEquals(
    check(
      meta({}, { extensions: { "no-prefix": {} } }),
      requestMeta,
    )[0].message,
    "is not a prefixed extension identifier",
  );
  assertEquals(
    check(meta({ traceparent: "00-bad" }), requestMeta)[0].message,
    "is not a W3C traceparent",
  );
  assertEquals(
    check(
      meta({
        traceparent: "00-0af7651916cd43dd8448eb211c80319c-00f067aa0ba902b7-01",
        tracestate: "a=b",
        baggage: "k=v",
      }),
      requestMeta,
    ),
    [],
  );
});

Deno.test("_meta key syntax and reserved prefixes follow the spec", () => {
  for (
    const key of [
      "progressToken",
      "io.modelcontextprotocol/protocolVersion",
      "com.example/x",
      "a/",
      "",
      "x.y_z-1",
    ]
  ) {
    assert(isValidMetaKey(key), key);
  }
  for (const key of ["-x", "x-", "1abc.def/x", "a..b/x", "a/b/c", "a b"]) {
    assert(!isValidMetaKey(key), key);
  }
  assert(
    isReservedMetaKey("io.modelcontextprotocol/x"),
    "io.modelcontextprotocol",
  );
  assert(isReservedMetaKey("dev.mcp/x"), "dev.mcp");
  assert(isReservedMetaKey("org.modelcontextprotocol.api/x"), "org...api");
  assert(isReservedMetaKey("com.mcp.tools/x"), "com.mcp.tools");
  assert(!isReservedMetaKey("com.example.mcp/x"), "com.example.mcp");
  assert(!isReservedMetaKey("progressToken"), "no prefix");
});

Deno.test("traceparent follows W3C Trace Context", () => {
  assert(
    isTraceparent("00-0af7651916cd43dd8448eb211c80319c-00f067aa0ba902b7-01"),
    "valid",
  );
  assert(
    !isTraceparent("00-00000000000000000000000000000000-00f067aa0ba902b7-01"),
    "zero trace id",
  );
  assert(
    !isTraceparent("ff-0af7651916cd43dd8448eb211c80319c-00f067aa0ba902b7-01"),
    "version ff",
  );
  assert(
    !isTraceparent("00-0AF7651916CD43DD8448EB211C80319C-00f067aa0ba902b7-01"),
    "uppercase",
  );
  assert(
    isTraceparent("01-0af7651916cd43dd8448eb211c80319c-00f067aa0ba902b7-01-ab"),
    "a later version may add fields",
  );
});

Deno.test("results are decoded strictly", () => {
  assertEquals(
    check({
      tools: [{ name: "t", inputSchema: { type: "object" } }],
      ttlMs: 0,
      cacheScope: "public",
    }, RESULT["tools/list"]),
    [],
  );
  assertEquals(
    check(
      { tools: [{ name: "t", inputSchema: { type: "string" } }] },
      RESULT["tools/list"],
    )
      .map((i) => i.message),
    ['expected "object", got "string"'],
  );
  assertEquals(
    check({ contents: [{ uri: "x" }] }, RESULT["resources/read"])[0].message,
    "must have exactly one of text or blob",
  );
  assertEquals(
    check({ content: [{ type: "video", data: "" }] }, RESULT["tools/call"])[0]
      .message,
    'expected "text" or "image" or "audio" or "resource_link" or "resource", got "video"',
  );
  assertEquals(
    check({ resultType: "input_required" }, inputRequiredResult)[0].message,
    "must have inputRequests or requestState",
  );
});

Deno.test("errors carry codes and data, and survive as plain data", async () => {
  const unsupported = McpError.unsupportedVersion(["2026-07-28"], "1900-01-01");
  assertEquals(unsupported.toRpcError(), {
    code: UNSUPPORTED_PROTOCOL_VERSION,
    message: "Unsupported protocol version",
    data: { supported: ["2026-07-28"], requested: "1900-01-01" },
  });
  assertEquals(unsupported.supportedVersions, ["2026-07-28"]);
  const missing = McpError.missingCapability({ elicitation: { url: {} } });
  assertEquals(missing.code, MISSING_REQUIRED_CLIENT_CAPABILITY);
  assertEquals(missing.requiredCapabilities, { elicitation: { url: {} } });
  assertEquals(McpError.headerMismatch("x").code, HEADER_MISMATCH);
  assertEquals(McpError.resourceNotFound("a://b").toRpcError(), {
    code: -32602,
    message: "Resource not found",
    data: { uri: "a://b" },
  });
  // A local failure never goes on the wire as anything but -32603.
  assertEquals(new McpError("timeout", "slow").toRpcError(), {
    code: -32603,
    message: "Internal error",
  });

  const legacy = new McpError("rpc", "gone", {
    code: LEGACY_RESOURCE_NOT_FOUND,
    method: "resources/read",
  });
  assert(legacy.resourceNotFound, "-32002 still means not found");
  const data = new McpError("http", "busy", { status: 503 }).toJSON();
  assertEquals(data.retryable, true);
  const back = mcpErrorFromData(JSON.parse(JSON.stringify(data)));
  assertEquals(back.toJSON(), data);

  assertEquals(await attempt(() => Promise.resolve(1)), {
    ok: true,
    result: 1,
  });
  const failed = await attempt(() => Promise.reject(McpError.internal()));
  assertEquals(failed.ok, false);
  let rethrown = false;
  try {
    await attempt(() => Promise.reject(new Error("other")));
  } catch {
    rethrown = true;
  }
  assert(rethrown, "non-MCP errors are rethrown");
});

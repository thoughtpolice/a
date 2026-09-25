// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

import { assert, assertEquals } from "@celld/assert";
import {
  argumentAt,
  decodeHeaderValue,
  encodeHeaderValue,
  paramHeaderMismatch,
  paramHeaders,
  paramHeaderValue,
} from "@celld/mcp";

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

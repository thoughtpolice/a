// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * Contracts for the JSON edge: routes, base64, and the status map.
 *
 * @module
 */

import * as http from "@wormspace/segment/http";
import { type AnyResult, LIMITS } from "@wormspace/segment/types";
import { assert, assertCode, assertEquals, assertOk } from "@celld/assert";

function decoded(op: http.Op, body: unknown) {
  const result = http.decodeRequest(op, body);
  return assertOk(result).call;
}

Deno.test("the route table maps exactly the documented paths", () => {
  assertEquals(http.parseRoute("GET", "/v1/segments/seg-1"), {
    ok: true,
    name: "seg-1",
    op: "status",
  });
  for (
    const op of [
      "alloc",
      "capture",
      "write",
      "read",
      "trim",
      "listen",
    ] as const
  ) {
    assertEquals(http.parseRoute("POST", `/v1/segments/seg-1/${op}`), {
      ok: true,
      name: "seg-1",
      op,
    });
  }
});

Deno.test("routes that do not exist are 404, not a domain rejection", () => {
  const misses = [
    ["POST", "/v1/segments/seg"],
    ["GET", "/v1/segments/seg/read"],
    ["POST", "/v1/segments/seg/watch"],
    ["GET", "/v1/segments/seg/listen"],
    ["POST", "/v1/segments/seg/status"],
    ["POST", "/v1/segments/seg/constructor"],
    ["POST", "/v1/segments/seg/__proto__"],
    ["POST", "/v1/segments/seg/write/extra"],
    ["GET", "/v1/segments"],
    ["GET", "/v1/logs/seg"],
    ["GET", "/v2/segments/seg"],
    ["GET", "/segments/seg"],
    ["GET", "/v1/segments/seg/"],
    ["GET", ""],
  ];
  for (const [method, path] of misses) {
    const route = http.parseRoute(method, path);
    assert(!route.ok, `${method} ${path} resolved`);
    assertEquals(route.status, 404, `${method} ${path}`);
  }
});

Deno.test("a malformed segment name is a client error on a real route", () => {
  const names: [string, number][] = [
    ["", 400],
    ["Seg", 400],
    ["-seg", 400],
    ["s eg", 400],
    ["%2Eseg", 400],
    ["x".repeat(129), 400],
    // An embedded separator is a different path, not a different name.
    ["s/eg", 404],
  ];
  for (const [name, status] of names) {
    const route = http.parseRoute("POST", `/v1/segments/${name}/write`);
    assert(!route.ok, `${name} resolved`);
    assertEquals(route.status, status, name);
  }
  assert(
    http.parseRoute("GET", `/v1/segments/${"x".repeat(128)}`).ok,
    "128 characters is legal",
  );
  assert(
    http.parseRoute("GET", "/v1/segments/a.b-c_1").ok,
    "punctuation is legal",
  );
});

Deno.test("the body cap is applied before the body is parsed", () => {
  assertCode(http.parseBody("x".repeat(LIMITS.bodyBytes + 1)), "TOO_LARGE");
  assertCode(http.parseBody("{not json"), "INVALID");
  assertEquals(assertOk(http.parseBody("")).body, {});
  assertEquals(assertOk(http.parseBody("   ")).body, {});
  assertEquals(assertOk(http.parseBody('{"start":1}')).body, { start: 1 });
});

Deno.test("status takes no body, and every other operation requires an object", () => {
  assertEquals(decoded("status", undefined), { op: "status" });
  for (
    const op of [
      "alloc",
      "capture",
      "write",
      "read",
      "trim",
      "listen",
    ] as const
  ) {
    for (const body of [null, 7, "text", [1, 2]]) {
      assertCode(http.decodeRequest(op, body), "INVALID");
    }
  }
});

Deno.test("fields other than byte payloads reach the core untouched", () => {
  const call = decoded("capture", {
    start: 3,
    end: 9,
    owner: "alpha",
    extra: true,
  });
  assert(call.op === "capture", "the operation is preserved");
  assertEquals(call.request, { start: 3, end: 9, owner: "alpha", extra: true });

  const read = decoded("read", { start: 1, count: 2, maxBytes: 3 });
  assert(read.op === "read", "the operation is preserved");
  assertEquals(read.request, { start: 1, count: 2, maxBytes: 3 });

  const trim = decoded("trim", { through: 4 });
  assert(trim.op === "trim", "the operation is preserved");
  assertEquals(trim.request, { through: 4 });

  const listen = decoded("listen", { since: 5, timeoutMs: 100 });
  assert(listen.op === "listen", "the operation is preserved");
  assertEquals(listen.request, { since: 5, timeoutMs: 100 });
});

Deno.test("alloc decodes its metadata and rejects anything that is not base64", () => {
  const call = decoded("alloc", {
    size: 8,
    metadata: "AP8=",
    allocator: "alpha",
  });
  assert(call.op === "alloc", "the operation is preserved");
  assertEquals(call.request, {
    size: 8,
    metadata: new Uint8Array([0, 255]),
    allocator: "alpha",
  });
  assertEquals(
    assertOk(http.decodeRequest("alloc", { size: 1, metadata: "" })).call,
    { op: "alloc", request: { size: 1, metadata: new Uint8Array(0) } },
  );
  for (const metadata of [undefined, null, 7, ["AA=="], "A", "a b", "AA==="]) {
    assertCode(http.decodeRequest("alloc", { size: 8, metadata }), "INVALID");
  }
});

Deno.test("write decodes its values and rejects anything that is not base64", () => {
  const call = decoded("write", {
    start: 4,
    values: ["", "AAE=", "/w=="],
    captureId: 7,
  });
  assert(call.op === "write", "the operation is preserved");
  assertEquals(call.request.start, 4);
  assertEquals(call.request.captureId, 7);
  assertEquals(call.request.values, [
    new Uint8Array(0),
    new Uint8Array([0, 1]),
    new Uint8Array([255]),
  ]);

  for (
    const values of [
      undefined,
      "AAE=",
      [1],
      [null],
      ["A"],
      ["AA=A"],
      ["a b"],
      ["AA==="],
    ]
  ) {
    assertCode(
      http.decodeRequest("write", { start: 0, values, captureId: 1 }),
      "INVALID",
    );
  }
});

Deno.test("every decoded value owns its buffer", () => {
  const call = decoded("write", {
    start: 0,
    values: ["AAAA", "AAAA"],
    captureId: 1,
  });
  assert(call.op === "write", "the operation is preserved");
  const [first, second] = call.request.values;
  assert(first.buffer !== second.buffer, "values shared a buffer");
  first[0] = 9;
  assertEquals(second[0], 0, "writing one value changed another");
});

Deno.test("base64 round-trips every byte value, at every size that matters", () => {
  const cases = [
    new Uint8Array(0),
    new Uint8Array([0]),
    new Uint8Array([0, 255]),
    Uint8Array.from({ length: 256 }, (_value, index) => index),
    Uint8Array.from(
      { length: LIMITS.valueBytes },
      (_value, index) => index % 256,
    ),
  ];
  for (const bytes of cases) {
    const text = http.encodeBase64(bytes);
    const back = http.decodeBase64(text);
    assert(back !== null, `${bytes.length} bytes failed to decode`);
    assertEquals(back.length, bytes.length);
    assert(back.every((byte, index) => byte === bytes[index]), "bytes changed");
  }
  assertEquals(http.encodeBase64(new Uint8Array([0, 1])), "AAE=");
  assertEquals(http.encodeBase64(new Uint8Array(0)), "");
});

Deno.test("a read window is encoded with base64 values and holes left bare", () => {
  const encoded = http.encodeResult({
    ok: true,
    registers: [
      {
        offset: 4,
        state: "written",
        round: 2,
        value: new Uint8Array([0, 255]),
      },
      { offset: 5, state: "written", round: 0, value: new Uint8Array(0) },
      { offset: 6, state: "captured", round: 3 },
      { offset: 7, state: "unwritten", round: 0 },
    ],
    size: 8,
    trimmedThrough: 3,
  });
  assertEquals(encoded, {
    ok: true,
    registers: [
      { offset: 4, state: "written", round: 2, value: "AP8=" },
      { offset: 5, state: "written", round: 0, value: "" },
      { offset: 6, state: "captured", round: 3 },
      { offset: 7, state: "unwritten", round: 0 },
    ],
    size: 8,
    trimmedThrough: 3,
  });
  assertEquals(
    JSON.parse(JSON.stringify(encoded)),
    encoded,
    "the result is JSON already",
  );
});

Deno.test("status and ALREADY_ALLOCATED carry their metadata as base64", () => {
  const status = {
    ok: true,
    allocated: true,
    size: 8,
    metadata: new Uint8Array([1, 2]),
    allocator: "alpha",
    allocatedMs: 5,
    nextRound: 3,
    writtenCount: 1,
    writes: 3,
    captures: 1,
    trimmedThrough: -1,
    databaseSize: 4096,
  } as const;
  assertEquals(http.encodeResult(status), { ...status, metadata: "AQI=" });
  assertEquals(
    http.encodeResult({ ...status, allocated: false, metadata: null }),
    { ...status, allocated: false, metadata: null },
  );
  const lost = {
    ok: false,
    code: "ALREADY_ALLOCATED",
    message: "the segment is already allocated",
    size: 8,
    metadata: new Uint8Array([255]),
    allocator: null,
    allocatedMs: 5,
  } as const;
  assertEquals(http.encodeResult(lost), { ...lost, metadata: "/w==" });
});

Deno.test("results without bytes are their own JSON", () => {
  const cases: AnyResult[] = [
    { ok: true, start: 1, end: 2 },
    { ok: true, captureId: 3, start: 0, end: 8, alreadyWritten: 0 },
    { ok: true, trimmedThrough: 2, deleted: 1 },
    { ok: true, writes: 7, changed: true },
    { ok: true, writes: 0, changed: false },
    {
      ok: false,
      code: "ALREADY_WRITTEN",
      message: "m",
      offset: 1,
      sameValue: true,
    },
  ];
  for (const result of cases) assertEquals(http.encodeResult(result), result);
});

Deno.test("every result code has one status", () => {
  const cases: [number, AnyResult][] = [
    [200, { ok: true, size: 8, allocatedMs: 1 }],
    [400, { ok: false, code: "INVALID", message: "bad" }],
    [400, { ok: false, code: "OUT_OF_RANGE", size: 8, message: "far" }],
    [413, { ok: false, code: "TOO_LARGE", message: "big" }],
    [409, { ok: false, code: "UNALLOCATED", message: "m" }],
    [409, {
      ok: false,
      code: "ALREADY_ALLOCATED",
      message: "m",
      size: 8,
      metadata: new Uint8Array(0),
      allocator: null,
      allocatedMs: 1,
    }],
    [409, {
      ok: false,
      code: "ALREADY_WRITTEN",
      message: "m",
      offset: 1,
      sameValue: false,
    }],
    [409, {
      ok: false,
      code: "CAPTURE_STALE",
      message: "m",
      offset: 1,
      round: 4,
      captureId: 3,
    }],
    [410, { ok: false, code: "TRIMMED", message: "m", trimmedThrough: 3 }],
  ];
  for (const [status, result] of cases) {
    assertEquals(http.httpStatus(result), status, JSON.stringify(result));
  }
});

// Copied from the journal's http_test.ts along with `retryableCause`.
Deno.test("only celld's transient failures are retryable; a bug never is", () => {
  const routing = Object.assign(new Error("owner unreachable"), {
    code: "owner_unreachable",
    retryable: true,
  });
  assertEquals(http.retryableCause(routing), "segment owner unreachable");
  assertEquals(
    http.retryableCause({ retryable: true }),
    "segment owner unreachable",
  );
  // What a crash failover looks like in 0.5.1: no code, just a message.
  assertEquals(
    http.retryableCause(
      new Error(
        "remote RPC transport failed: error sending request for url " +
          "(http://127.0.0.1:1/peer/tunnel): client error (Connect): " +
          "tcp connect error: Connection refused (os error 111)",
      ),
    ),
    "segment owner unreachable",
  );
  assertEquals(
    http.retryableCause(new Error("route failed: DurabilityUnproven")),
    "durability unproven; the request may or may not have applied",
  );
  assertEquals(
    http.retryableCause(
      new Error("route RPC Segment:22434a2032a248d697aeaaff: RestoreFailed"),
    ),
    "segment route failed: RestoreFailed",
  );
  assertEquals(
    http.retryableCause(new Error("route failed: something else")),
    "segment route failed: something else",
  );
  assertEquals(
    http.retryableCause(new Error("route failed")),
    "segment route failed: route failed",
  );
  for (
    const bug of [
      new TypeError("stub.write is not a function"),
      new Error("transport failed later in the message"),
      { code: "other" },
      "remote RPC transport failed",
      null,
      undefined,
    ]
  ) {
    assertEquals(http.retryableCause(bug), null, String(bug));
  }
});

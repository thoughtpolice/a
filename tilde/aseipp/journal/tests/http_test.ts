// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * Contracts for the JSON edge: routes, base64, and the status map.
 *
 * @module
 */

import * as http from "@journal/http";
import { type AnyResult, LIMITS } from "@journal/types";
import { assert, assertCode, assertEquals, assertOk } from "@celld/assert";

function decoded(op: http.Op, body: unknown) {
  const result = http.decodeRequest(op, body);
  return assertOk(result).call;
}

Deno.test("the route table maps exactly the documented paths", () => {
  assertEquals(http.parseRoute("GET", "/v1/logs/orders"), {
    ok: true,
    name: "orders",
    op: "status",
  });
  const posts: [string, http.Op][] = [
    ["acquire-lease", "acquireLease"],
    ["renew-lease", "renewLease"],
    ["release-lease", "releaseLease"],
    ["append", "append"],
    ["read", "read"],
    ["record-snapshot", "recordSnapshot"],
    ["trim", "trim"],
  ];
  for (const [segment, op] of posts) {
    assertEquals(http.parseRoute("POST", `/v1/logs/orders/${segment}`), {
      ok: true,
      name: "orders",
      op,
    });
  }
});

Deno.test("routes that do not exist are 404, not a domain rejection", () => {
  const misses = [
    ["POST", "/v1/logs/orders"],
    ["GET", "/v1/logs/orders/append"],
    ["POST", "/v1/logs/orders/compact"],
    ["POST", "/v1/logs/orders/append/extra"],
    // Inherited object properties are not operations.
    ["POST", "/v1/logs/orders/constructor"],
    ["POST", "/v1/logs/orders/__proto__"],
    ["POST", "/v1/logs/orders/toString"],
    ["POST", "/v1/logs/orders/hasOwnProperty"],
    ["GET", "/v1/logs"],
    ["GET", "/v2/logs/orders"],
    ["GET", "/logs/orders"],
    ["GET", "/v1/logs/orders/"],
    ["GET", ""],
  ];
  for (const [method, path] of misses) {
    const route = http.parseRoute(method, path);
    assert(!route.ok, `${method} ${path} resolved`);
    assertEquals(route.status, 404, `${method} ${path}`);
  }
});

Deno.test("a malformed log name is a client error on a real route", () => {
  const names: [string, number][] = [
    ["", 400],
    ["Orders", 400],
    ["-orders", 400],
    ["or ders", 400],
    ["%2Eorders", 400],
    ["x".repeat(129), 400],
    // An embedded separator is a different path, not a different name.
    ["or/ders", 404],
  ];
  for (const [name, status] of names) {
    const route = http.parseRoute("POST", `/v1/logs/${name}/append`);
    assert(!route.ok, `${name} resolved`);
    assertEquals(route.status, status, name);
  }
  assert(
    http.parseRoute("GET", `/v1/logs/${"x".repeat(128)}`).ok,
    "128 characters is legal",
  );
  assert(http.parseRoute("GET", "/v1/logs/a.b-c_1").ok, "punctuation is legal");
});

Deno.test("the body cap is applied before the body is parsed", () => {
  assertCode(http.parseBody("x".repeat(LIMITS.bodyBytes + 1)), "TOO_LARGE");
  assertCode(http.parseBody("{not json"), "INVALID");
  assertEquals(assertOk(http.parseBody("")).body, {});
  assertEquals(assertOk(http.parseBody("   ")).body, {});
  assertEquals(assertOk(http.parseBody('{"from":1}')).body, { from: 1 });
});

Deno.test("status takes no body, and every other operation requires one", () => {
  assertEquals(decoded("status", undefined), { op: "status" });
  for (const op of ["acquireLease", "read", "trim"] as const) {
    for (const body of [null, 7, "text", [1, 2]]) {
      assertCode(http.decodeRequest(op, body), "INVALID");
    }
  }
});

Deno.test("fields other than record payloads reach the core untouched", () => {
  const call = decoded("acquireLease", {
    candidate: "alpha",
    ttlMs: 30_000,
    extra: true,
  });
  assert(call.op === "acquireLease", "the operation is preserved");
  assertEquals(call.request.candidate, "alpha");
  assertEquals(call.request.ttlMs, 30_000);
});

Deno.test("append decodes its payloads and rejects anything that is not base64", () => {
  const call = decoded("append", {
    leader: "alpha",
    records: ["", "AAE=", "/w=="],
    expectedNextSeq: 4,
  });
  assert(call.op === "append", "the operation is preserved");
  assertEquals(call.request.leader, "alpha");
  assertEquals(call.request.expectedNextSeq, 4);
  assertEquals(call.request.records, [
    new Uint8Array(0),
    new Uint8Array([0, 1]),
    new Uint8Array([255]),
  ]);

  for (
    const records of [
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
      http.decodeRequest("append", { leader: "alpha", records }),
      "INVALID",
    );
  }
});

Deno.test("every decoded record owns its buffer", () => {
  const call = decoded("append", {
    leader: "alpha",
    records: ["AAAA", "AAAA"],
  });
  assert(call.op === "append", "the operation is preserved");
  const [first, second] = call.request.records;
  assert(first.buffer !== second.buffer, "records shared a buffer");
  first[0] = 9;
  assertEquals(second[0], 0, "writing one record changed another");
});

Deno.test("base64 round-trips every byte value, at every size that matters", () => {
  const cases = [
    new Uint8Array(0),
    new Uint8Array([0]),
    new Uint8Array([0, 255]),
    Uint8Array.from({ length: 256 }, (_value, index) => index),
    Uint8Array.from(
      { length: LIMITS.recordBytes },
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

Deno.test("a read window is encoded with base64 payloads", () => {
  const encoded = http.encodeResult({
    ok: true,
    records: [
      { seq: 4, term: 2, payload: new Uint8Array([0, 255]) },
      { seq: 5, term: 2, payload: new Uint8Array(0) },
    ],
    head: 6,
    trimmedThrough: 3,
    snapshot: { throughSeq: 3, ref: "s3://snap/3" },
  });
  assertEquals(encoded, {
    ok: true,
    records: [
      { seq: 4, term: 2, payload: "AP8=" },
      { seq: 5, term: 2, payload: "" },
    ],
    head: 6,
    trimmedThrough: 3,
    snapshot: { throughSeq: 3, ref: "s3://snap/3" },
  });
  assertEquals(
    JSON.parse(JSON.stringify(encoded)),
    encoded,
    "the result is JSON already",
  );
});

Deno.test("results without payloads are their own JSON", () => {
  const result: AnyResult = { ok: true, firstSeq: 1, lastSeq: 2, term: 3 };
  assertEquals(http.encodeResult(result), result);
});

Deno.test("every result code has one status, and none leaks the leader token", () => {
  const cases: [number, AnyResult][] = [
    [200, { ok: true, term: 1, deadlineMs: 2, nowMs: 1 }],
    [400, { ok: false, code: "INVALID", message: "bad" }],
    [413, { ok: false, code: "TOO_LARGE", message: "big" }],
    [409, { ok: false, code: "LEASE_HELD", term: 1, deadlineMs: 2, nowMs: 1 }],
    [409, { ok: false, code: "NOT_LEADER", term: 1 }],
    [409, { ok: false, code: "SEQ_MISMATCH", head: 4, term: 1 }],
    [409, { ok: false, code: "SNAPSHOT_STALE", snapshot: null }],
    [410, { ok: false, code: "TRIMMED", trimmedThrough: 3, snapshot: null }],
  ];
  for (const [status, result] of cases) {
    assertEquals(http.httpStatus(result), status, JSON.stringify(result));
    if (!result.ok) {
      assert(!("leader" in result), "a conflict disclosed the leader token");
    }
  }
});

Deno.test("only celld's transient failures are retryable; a bug never is", () => {
  const routing = Object.assign(new Error("owner unreachable"), {
    code: "owner_unreachable",
    retryable: true,
  });
  assertEquals(http.retryableCause(routing), "journal owner unreachable");
  assertEquals(
    http.retryableCause({ retryable: true }),
    "journal owner unreachable",
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
    "journal owner unreachable",
  );
  assertEquals(
    http.retryableCause(new Error("route failed: DurabilityUnproven")),
    "durability unproven; the request may or may not have applied",
  );
  assertEquals(
    http.retryableCause(
      new Error("route RPC Journal:22434a2032a248d697aeaaff: RestoreFailed"),
    ),
    "journal route failed: RestoreFailed",
  );
  assertEquals(
    http.retryableCause(new Error("route failed: something else")),
    "journal route failed: something else",
  );
  assertEquals(
    http.retryableCause(new Error("route failed")),
    "journal route failed: route failed",
  );
  for (
    const bug of [
      new TypeError("stub.append is not a function"),
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

Deno.test("the journal cell's own unavailable errors carry their cause", () => {
  assertEquals(
    http.retryableCause(
      new Error(
        `${http.UNAVAILABLE_PREFIX}durability unproven; the request may or ` +
          "may not have applied",
      ),
    ),
    "durability unproven; the request may or may not have applied",
  );
  // However a transport renders the message around it.
  assertEquals(
    http.retryableCause({
      message: `Error: ${http.UNAVAILABLE_PREFIX}link 3 was captured twice`,
    }),
    "link 3 was captured twice",
  );
  assertEquals(
    http.retryableCause(new Error("journal: reading link 0 at 4: {}")),
    null,
    "a bookkeeping bug is not retryable",
  );
});

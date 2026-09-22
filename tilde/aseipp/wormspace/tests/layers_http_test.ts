// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * Contracts for the WormLog and WormPaxos JSON edge: routes, decoding,
 * base64 for records, and the status map.
 *
 * @module
 */

import * as layers from "@wormspace/layers/layers_http";
import { assertCode, assertEquals, assertOk } from "@celld/assert";

Deno.test("the layer routes map exactly the documented paths", () => {
  for (
    const op of ["init", "append", "read", "tail", "fill", "trim", "listen"]
  ) {
    assertEquals(layers.parseLayerRoute("POST", `/v1/wormlog/log-1/${op}`), {
      ok: true,
      layer: "wormlog",
      log: "log-1",
      op,
    });
  }
  for (const op of ["init", "propose", "learn", "get", "state"]) {
    assertEquals(
      layers.parseLayerRoute("POST", `/v1/wormpaxos/kv.1/r-2/${op}`),
      { ok: true, layer: "wormpaxos", smr: "kv.1", replica: "r-2", op },
    );
  }
});

Deno.test("paths outside both layers are left to the segment routes", () => {
  for (
    const path of [
      "/v1/segments/seg",
      "/v1/segments/seg/read",
      "/",
      "",
      "/v2/wormlog/log/append",
      "/wormlog/log/append",
    ]
  ) {
    assertEquals(layers.parseLayerRoute("POST", path), null, path);
  }
});

Deno.test("unknown layer routes are 404 and bad names are 400", () => {
  for (
    const [method, path] of [
      ["GET", "/v1/wormlog/log/tail"],
      ["POST", "/v1/wormlog/log"],
      ["POST", "/v1/wormlog/log/append/extra"],
      ["POST", "/v1/wormlog/log/constructor"],
      ["POST", "/v1/wormlog/log/__proto__"],
      ["POST", "/v1/wormlog/log/next"],
      ["POST", "/v1/wormpaxos/g/a"],
      ["POST", "/v1/wormpaxos/g/a/lookup"],
      ["POST", "/v1/wormpaxos/g/a/propose/x"],
      ["GET", "/v1/wormpaxos/g/a/state"],
    ]
  ) {
    const route = layers.parseLayerRoute(method, path);
    assertEquals(
      route,
      { ok: false, status: 404, code: "NOT_FOUND", message: "unknown route" },
      `${method} ${path}`,
    );
  }
  for (
    const path of [
      "/v1/wormlog/Log/append",
      "/v1/wormlog/%2Elog/append",
      `/v1/wormlog/${"x".repeat(118)}/append`,
      "/v1/wormpaxos/G/a/state",
      "/v1/wormpaxos/g/A/state",
      "/v1/wormpaxos/g/a.b/state",
      `/v1/wormpaxos/g/${"r".repeat(33)}/state`,
    ]
  ) {
    const route = layers.parseLayerRoute("POST", path);
    assertEquals(route?.ok, false, path);
    assertEquals((route as { status: number }).status, 400, path);
  }
});

Deno.test("append's value is base64; everything else passes through", () => {
  assertEquals(
    assertOk(layers.decodeLogRequest("append", { value: "AAH/" })).call,
    { op: "append", value: new Uint8Array([0, 1, 255]) },
  );
  assertCode(layers.decodeLogRequest("append", {}), "INVALID");
  assertCode(layers.decodeLogRequest("append", { value: "not!" }), "INVALID");
  assertCode(layers.decodeLogRequest("append", { value: 3 }), "INVALID");
  assertCode(layers.decodeLogRequest("read", []), "INVALID");
  assertCode(layers.decodeLogRequest("tail", null), "INVALID");
  assertEquals(
    assertOk(layers.decodeLogRequest("read", { from: 3, count: 2 })).call,
    { op: "read", request: { from: 3, count: 2 } },
  );
  assertEquals(
    assertOk(layers.decodeLogRequest("fill", { slot: "x" })).call,
    { op: "fill", slot: "x" as unknown as number },
  );
  assertEquals(
    assertOk(layers.decodeLogRequest("listen", { from: 1, since: 2 })).call,
    { op: "listen", request: { from: 1, since: 2 } },
  );
  assertEquals(
    assertOk(layers.decodePaxosRequest("propose", { command: { op: "noop" } }))
      .call,
    { op: "propose", fields: { command: { op: "noop" } } },
  );
  assertCode(layers.decodePaxosRequest("state", "x"), "INVALID");
});

Deno.test("read entries' records are base64 on the way out", () => {
  assertEquals(
    layers.encodeLayerResult({
      ok: true,
      entries: [
        { slot: 0, state: "value", value: new Uint8Array([0, 255]) },
        { slot: 1, state: "hole" },
        { slot: 2, state: "pending" },
      ],
      next: 3,
    }),
    {
      ok: true,
      entries: [
        { slot: 0, state: "value", value: "AP8=" },
        { slot: 1, state: "hole" },
        { slot: 2, state: "pending" },
      ],
      next: 3,
    },
  );
  const plain = { ok: true, slot: 4, attempts: 1 };
  assertEquals(layers.encodeLayerResult(plain), plain);
});

Deno.test("the status map sends each code to the status a client acts on", () => {
  const cases: [string | null, number][] = [
    [null, 200],
    ["INVALID", 400],
    ["OUT_OF_RANGE", 400],
    ["TOO_LARGE", 413],
    ["TRIMMED", 410],
    ["CONTENDED", 503],
    ["UNALLOCATED", 409],
    ["CHAIN_MISMATCH", 409],
    ["CONFLICT", 409],
    ["ALREADY_WRITTEN", 409],
    ["CAPTURE_STALE", 409],
    ["SOMETHING_NEW", 500],
  ];
  for (const [code, status] of cases) {
    const result = code === null ? { ok: true } : { ok: false, code };
    assertEquals(layers.layerStatus(result), status, String(code));
  }
});

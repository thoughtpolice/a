// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * The entry codec both layers write into registers.
 *
 * @module
 */

import {
  decodeEntry,
  encodeValue,
  holeBytes,
  MAX_PAYLOAD_BYTES,
  TAG_HOLE,
  TAG_VALUE,
} from "@wormspace/layers/entry";
import { LIMITS } from "@wormspace/segment/types";
import { assert, assertCode, assertEquals, assertOk } from "@celld/assert";

Deno.test("a value entry is its tag then its payload, and round-trips", () => {
  for (
    const payload of [
      new Uint8Array(0),
      new Uint8Array([0]),
      new Uint8Array([1]),
      new Uint8Array([0, 1, 2, 255]),
      new TextEncoder().encode("wormlog ✓"),
    ]
  ) {
    const bytes = assertOk(encodeValue(payload)).bytes;
    assertEquals(bytes[0], TAG_VALUE);
    assertEquals(bytes.subarray(1), payload);
    assertEquals(assertOk(decodeEntry(bytes)).entry, {
      kind: "value",
      value: payload,
    });
  }
});

Deno.test("a hole is exactly one byte and carries nothing", () => {
  assertEquals(holeBytes(), new Uint8Array([TAG_HOLE]));
  assertEquals(assertOk(decodeEntry(holeBytes())).entry, { kind: "hole" });
  assertCode(decodeEntry(new Uint8Array([TAG_HOLE, 0])), "INVALID");
  // A value entry whose payload is the hole's byte is still a value.
  const tricky = assertOk(encodeValue(new Uint8Array([TAG_HOLE]))).bytes;
  assertEquals(assertOk(decodeEntry(tricky)).entry.kind, "value");
});

Deno.test("anything else is not an entry", () => {
  assertCode(decodeEntry(new Uint8Array(0)), "INVALID");
  for (const tag of [2, 0x7f, 0xff]) {
    assertCode(decodeEntry(new Uint8Array([tag, 1, 2])), "INVALID");
  }
});

Deno.test("the largest payload fills a register exactly", () => {
  assertEquals(MAX_PAYLOAD_BYTES, LIMITS.valueBytes - 1);
  const largest = assertOk(encodeValue(new Uint8Array(MAX_PAYLOAD_BYTES)));
  assertEquals(largest.bytes.byteLength, LIMITS.valueBytes);
  assertCode(encodeValue(new Uint8Array(MAX_PAYLOAD_BYTES + 1)), "TOO_LARGE");
  assertCode(encodeValue("x" as unknown as Uint8Array), "INVALID");
});

Deno.test("decoding copies, so a payload never aliases the register", () => {
  const bytes = assertOk(encodeValue(new Uint8Array([7, 8]))).bytes;
  const decoded = assertOk(decodeEntry(bytes)).entry;
  assert(decoded.kind === "value", "a value");
  bytes[1] = 99;
  assertEquals(decoded.value, new Uint8Array([7, 8]));
});

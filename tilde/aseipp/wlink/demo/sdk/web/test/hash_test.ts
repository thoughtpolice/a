// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

import { assertEquals } from "../assert.ts";
import { Fnv1a, fnv1a, hex } from "../hash.ts";

const encoder = new TextEncoder();

function reference(bytes: Uint8Array): string {
  let hash = 0xcbf29ce484222325n;
  const mask = 0xffffffffffffffffn;
  for (const byte of bytes) {
    hash = ((hash ^ BigInt(byte)) * 0x100000001b3n) & mask;
  }
  return hash.toString(16).padStart(16, "0");
}

Deno.test("the published FNV-1a 64 test vectors", () => {
  assertEquals(fnv1a(encoder.encode("")), "cbf29ce484222325");
  assertEquals(fnv1a(encoder.encode("a")), "af63dc4c8601ec8c");
  assertEquals(fnv1a(encoder.encode("foobar")), "85944171f73967e8");
});

Deno.test("hashing in chunks matches hashing at once", () => {
  const bytes = encoder.encode("the quick brown fox jumps over the lazy dog");
  const chunked = new Fnv1a();
  for (let at = 0; at < bytes.length; at += 7) {
    chunked.update(bytes.subarray(at, Math.min(at + 7, bytes.length)));
  }
  assertEquals(chunked.hex(), fnv1a(bytes));

  const single = new Fnv1a();
  for (const byte of bytes) single.byte(byte);
  assertEquals(single.hex(), fnv1a(bytes));
});

Deno.test("a megabyte of pseudorandom bytes matches a bigint reference", () => {
  const bytes = new Uint8Array(1024 * 1024);
  let state = 0x12345678;
  for (let i = 0; i < bytes.length; i++) {
    state = (Math.imul(state, 1103515245) + 12345) >>> 0;
    bytes[i] = (state >>> 16) & 0xff;
  }
  assertEquals(fnv1a(bytes), reference(bytes));
});

Deno.test("every half is padded to eight digits", () => {
  assertEquals(hex(0, 0), "0000000000000000");
  assertEquals(hex(1, 0xff), "00000001000000ff");
  assertEquals(hex(0xffffffff, 0xffffffff), "ffffffffffffffff");
});

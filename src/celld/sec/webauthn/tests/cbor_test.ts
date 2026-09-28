// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

import { assertEquals, assertThrows } from "@celld/core/assert";
import { CborError, decodeCbor, encodeCbor } from "@celld/sec/webauthn";

function hex(text: string): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(text.match(/../g) ?? [], (b) => parseInt(b, 16));
}

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

Deno.test("cbor: the subset decodes, keeping integer and text keys apart", () => {
  // {1: 2, 3: -7, -1: 1, "fmt": "none", "x": h'0102', "ok": [true, false, null]}
  const value = decodeCbor(hex(
    "a6" + "0102" + "0326" + "2001" + "63666d74646e6f6e65" + "6178420102" +
      "626f6b83f5f4f6",
  )).value as Map<number | string, unknown>;
  assertEquals(value.get(1), 2);
  assertEquals(value.get(3), -7);
  assertEquals(value.get(-1), 1);
  assertEquals(value.get("fmt"), "none");
  assertEquals([...(value.get("x") as Uint8Array)], [1, 2]);
  assertEquals(value.get("ok"), [true, false, null]);
});

Deno.test("cbor: integers of every width, and the safe-integer bound", () => {
  assertEquals(decodeCbor(hex("17")).value, 23);
  assertEquals(decodeCbor(hex("1818")).value, 24);
  assertEquals(decodeCbor(hex("190100")).value, 256);
  assertEquals(decodeCbor(hex("1a00010000")).value, 65536);
  assertEquals(decodeCbor(hex("1b001fffffffffffff")).value, 2 ** 53 - 1);
  assertEquals(decodeCbor(hex("3818")).value, -25);
  assertThrows(
    () => decodeCbor(hex("1b0020000000000000")),
    CborError,
    "too large",
  );
  assertThrows(
    () => decodeCbor(hex("3b001fffffffffffff")),
    CborError,
    "too large",
  );
});

Deno.test("cbor: everything outside the subset is refused", () => {
  const cases: [string, string][] = [
    ["5f", "indefinite"], // indefinite byte string
    ["9f", "indefinite"], // indefinite array
    ["c1", "tags"], // tag 1
    ["f93c00", "floats"], // half float
    ["fb3ff0000000000000", "floats"], // double
    ["f7", "simple value 23"], // undefined
    ["1c", "reserved"], // additional information 28
    ["a201020103", "repeats"], // {1: 2, 1: 3}
    ["a1400102", "key must be"], // {h'': 1}, then junk
    ["0102", "follow"], // trailing byte
    ["4401", "runs past"], // byte string longer than the input
    ["62ff00", "UTF-8"], // bad UTF-8
    ["9affffffff", "longer than the input"], // an array claiming 2^32 items
    ["", "ends in the middle"],
  ];
  for (const [input, message] of cases) {
    assertThrows(() => decodeCbor(hex(input)), CborError, message);
  }
});

Deno.test("cbor: nesting is bounded", () => {
  const deep = "81".repeat(9) + "00";
  assertThrows(() => decodeCbor(hex(deep)), CborError, "deeper than 8");
  assertEquals(decodeCbor(hex(deep), { maxDepth: 9 }).end, 10);
});

Deno.test("cbor: partial decoding reports where an item ends", () => {
  const bytes = hex("ff" + "a10102" + "a0" + "00");
  const first = decodeCbor(bytes, { offset: 1, partial: true });
  assertEquals(first.end, 4);
  const second = decodeCbor(bytes, { offset: first.end, partial: true });
  assertEquals([second.end, (second.value as Map<number, unknown>).size], [
    5,
    0,
  ]);
});

Deno.test("cbor: unsorted keys and long encodings are tolerated", () => {
  // {3: -7, 1: 2}, and 5 written with a one-byte argument.
  assertEquals(
    [...(decodeCbor(hex("a203260102")).value as Map<number, number>).keys()],
    [3, 1],
  );
  assertEquals(decodeCbor(hex("1805")).value, 5);
});

Deno.test("cbor: encoding is CTAP2 canonical and round-trips", () => {
  const map = new Map<number | string, number | string>([
    ["authData", 1],
    [-2, "x"],
    ["fmt", 2],
    [3, -7],
    [1, 2],
    ["attStmt", 3],
    [-1, 1],
  ]);
  const bytes = encodeCbor(map);
  const decoded = decodeCbor(bytes).value as Map<number | string, unknown>;
  // Integers (by encoding), then text strings shortest first.
  assertEquals([...decoded.keys()], [
    1,
    3,
    -1,
    -2,
    "fmt",
    "attStmt",
    "authData",
  ]);
  assertEquals(toHex(encodeCbor(256)), "190100");
  assertEquals(toHex(encodeCbor(-25)), "3818");
  assertEquals(
    toHex(encodeCbor([true, null, new Uint8Array([7])])),
    "83f5f64107",
  );
  assertEquals(
    toHex(encodeCbor({ b: 1, a: 2 })),
    "a2616102616201",
  );
  assertThrows(() => encodeCbor(1.5), CborError);
});

// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

import {
  assert,
  assertCode,
  assertEquals,
  assertOk,
  assertRejects,
  assertThrows,
  equals,
  show,
} from "@celld/assert";

function throws(fn: () => void): string {
  return assertThrows(fn).message;
}

Deno.test("equals compares plain data structurally", () => {
  assert(equals({ a: [1, { b: "c" }] }, { a: [1, { b: "c" }] }), "objects");
  assert(equals(new Uint8Array([1, 2]), new Uint8Array([1, 2])), "bytes");
  assert(!equals(new Uint8Array([1, 2]), new Uint8Array([1, 3])), "bytes");
  assert(!equals({ a: 1 }, { a: 1, b: 2 }), "extra key");
  assert(!equals([1], [1, 2]), "length");
  assert(!equals(null, {}), "null");
});

Deno.test("show spells out byte arrays", () => {
  assertEquals(show({ bytes: new Uint8Array([7]) }), '{"bytes":[7]}');
  assertEquals(show(undefined), "undefined");
});

Deno.test("failures carry the values", () => {
  assertEquals(
    throws(() => assertEquals(1, 2, "sum")),
    "sum: expected 2, got 1",
  );
  assertEquals(
    throws(() => assertCode({ code: "A" }, "B")),
    'expected code B, got {"code":"A"}',
  );
  assertEquals(
    throws(() => assertOk({ ok: false })),
    'expected ok, got {"ok":false}',
  );
  assertEquals(assertOk({ ok: true, value: 3 }).value, 3);
});

Deno.test("assertThrows returns the error, checking class and message", () => {
  const error = assertThrows(
    () => {
      throw new RangeError("out of range: 7");
    },
    RangeError,
    "range",
  );
  const _typed: RangeError = error;
  assertEquals(error.message, "out of range: 7");
  assertEquals(throws(() => assertThrows(() => 1)), "expected a throw");
  assertEquals(
    throws(() =>
      assertThrows(() => {
        throw new Error("plain");
      }, TypeError)
    ),
    "expected TypeError to be thrown, got Error: plain",
  );
  assertEquals(
    throws(() =>
      assertThrows(() => {
        throw "text";
      })
    ),
    "expected an Error to be thrown, got text",
  );
  assertEquals(
    throws(() =>
      assertThrows(
        () => {
          throw new Error("plain");
        },
        Error,
        "fancy",
      )
    ),
    'expected a message containing "fancy", got "plain"',
  );
  assertEquals(
    throws(() => assertThrows(() => Promise.reject(new Error("later")))),
    "expected a throw, got a promise (use assertRejects)",
  );
});

Deno.test("assertRejects takes a promise or a function", async () => {
  const error = await assertRejects(
    Promise.reject(new TypeError("bad")),
    TypeError,
  );
  assertEquals(error.message, "bad");
  assertEquals(
    (await assertRejects(() => {
      throw new Error("sync");
    })).message,
    "sync",
  );
  assertEquals(
    (await assertRejects(async () => await assertRejects(async () => {})))
      .message,
    "expected a rejection",
  );
  assertEquals(
    (await assertRejects(() =>
      assertRejects(Promise.reject(new Error("x")), RangeError)
    )).message,
    "expected RangeError to be thrown, got Error: x",
  );
});

// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

// tests/NativeIntegers.cs: native integers, and BigInteger's hash and
// text, as they are here.
import { checker } from "./checker.mjs";

export function checkNativeIntegers(exports, assert) {
  const natives = checker(exports, assert, "Tests.NativeIntegers.Natives.", {
    reset: ["Size", [], 188, "native integers fault reset"],
  });
  const { equal, expect, trap } = natives;

  // IntPtr.Size is 8, the memory little-endian.
  expect("Size", [], 188);

  // nuint arrays, fields and boxes: 0x1_0000_0001 * (0 + 1 + 2 + 3) - 4
  // + 15 - 3.
  expect("Arrays", [4], 6n * 0x1_0000_0001n - 4n + 15n - 3n);

  // Vector128 of native integers is two 64-bit lanes.
  const a = 0x0123456789abcdefn;
  const b = -5n;
  const rotate = (x) =>
    BigInt.asIntN(
      64,
      (BigInt.asUintN(64, x) << 4n) | (BigInt.asUintN(64, x) >> 60n),
    );
  expect("Lanes", [a, b], rotate(a) ^ rotate(b) ^ (b >> 1n) ^ 1n);

  // Equal values hash alike; a small value's hash is itself; the hash is
  // the same in every run (the CLR's is seeded per process).
  expect("Hashes", [0], 1 + 30 + 100);
  expect("Hashes", [5], 1 + 30 + 100);
  equal(
    exports["Tests.NativeIntegers.Natives.Hash"](),
    exports["Tests.NativeIntegers.Natives.Hash"](),
    "a deterministic hash",
  );

  for (let which = 0; which < 5; which++) expect("Text", [which], 1);

  // The default budgets: 300 digits fit, 20,000 do not.
  expect("Huge", [300], 301);
  trap("Huge", [20000], 1);
  return natives.checks;
}

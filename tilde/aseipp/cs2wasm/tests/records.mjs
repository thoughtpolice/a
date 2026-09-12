// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

// Shared by the ordinary, optimized, and alternate-engine Wasm runs. The
// expected values are the CLR's (see tests/differential.mjs).
import { checker } from "./checker.mjs";

export function checkRecords(exports, assert) {
  const records = checker(exports, assert, "Tests.Records.Records.", {
    reset: ["Generic", [3], 49, "records fault reset"],
  });
  const { expect, trap } = records;

  expect("Equality", [3], 194085);
  expect("Inheritance", [3], 3760);
  expect("With", [4], 1511);
  expect("Copies", [3], 1012210);
  expect("Printing", [8], -359552021);
  expect("Printing", [13], 1777852929);
  expect("Printing", [15], -2131967137);
  expect("Deconstruction", [2], 123182);
  expect("Patterns", [6], 15837140);
  expect("Keys", [4], 130001776);
  expect("UserMembers", [3], -540789);
  expect("Structs", [5], 8100812);
  expect("Initializers", [3], 8661717);
  expect("FloatEquality", [1], 11);
  expect("ArrayMembers", [1], 5);
  expect("Owners", [2], 122);
  // `with` and deconstruction of a null record.
  trap("WithNull", [0], 5);
  trap("DeconstructNull", [-1], 5);
  return records.checks;
}

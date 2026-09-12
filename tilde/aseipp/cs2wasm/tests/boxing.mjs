// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

// Shared by the ordinary, optimized, and alternate-engine Wasm runs. The
// expected values are the CLR's (see tests/differential.mjs); fault 19 is
// this compiler's where the CLR answers with what it does not keep.
import { checker } from "./checker.mjs";

export function checkBoxing(exports, assert) {
  const boxing = checker(exports, assert, "Tests.Boxing.Boxing.", {
    reset: ["Identity", [3], 217, "boxing fault reset"],
  });
  const { expect, trap } = boxing;

  expect("Identity", [3], 217);
  expect("Unboxing", [13], 1);
  expect("EnumUnboxing", [2], 1);
  expect("Copies", [5], 100006005);
  expect("Interfaces", [2], 170807291);
  expect("Patterns", [14], 2000);
  expect("TypeTests", [6], 88);
  expect("Casts", [12], 12);
  expect("Equality", [4], 7);
  expect("Overrides", [3], 1223);
  expect("Keys", [2], 45853270);
  expect("Printing", [8], 269561002);
  expect("Printing", [10], -2130005602);
  expect("Unions", [4], 30004);
  expect("UnionValues", [1], 404);
  expect("NestedUnions", [3], 43);
  expect("InterfaceUnions", [0], 109);
  expect("UnionEquality", [1], 51);
  expect("Generic", [7], 140086045);
  expect("Arrays", [3], 1113);
  // A box of another type, and null, do not unbox.
  trap("Unboxing", [3], 13);
  trap("EnumUnboxing", [3], 13);
  trap("UnboxNull", [], 5);
  expect("ArrayHash", [], 1);
  expect("EnumText", [], 3);
  expect("ArrayText", [], 14);
  expect("DelegateEquality", [], 1);
  return boxing.checks;
}

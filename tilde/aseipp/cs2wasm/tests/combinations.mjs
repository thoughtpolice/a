// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

// Shared by the ordinary, optimized, and alternate-engine Wasm runs. The
// expected values are the CLR's (see tests/differential.mjs).
import { checker } from "./checker.mjs";

export function checkCombinations(exports, assert) {
  const combinations = checker(
    exports,
    assert,
    "Tests.Combinations.Combinations.",
  );
  const { expect } = combinations;

  expect("GenericStructs", [5], 305210242);
  expect("NestedCollections", [8], 105278);
  // Static state per instantiation persists from one call to the next.
  expect("GenericStatics", [5], 2116);
  expect("GenericStatics", [2], 4240);
  expect("Inventory", [8], 909);
  expect("StructsInClosuresAndCollections", [5], 69902);
  expect("ExceptionsInGenericCode", [5], 2020);
  expect("EnumeratorOverStructs", [5], 13010);
  return combinations.checks;
}

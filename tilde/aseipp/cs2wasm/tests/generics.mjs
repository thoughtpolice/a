// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

// Shared by the ordinary, optimized, and alternate-engine Wasm runs.
import { checker } from "./checker.mjs";

export function checkGenerics(exports, assert) {
  const generics = checker(exports, assert, "Tests.GenericTypes.Generics.", {
    reset: ["Pairs", [4], 909, "generics fault reset"],
  });
  const { expect, trap } = generics;

  // The per-instantiation counters come first: their state persists.
  expect("StaticsPerInstantiation", [2], 1021112);
  expect("StaticsPerInstantiation", [1], 1031122);
  expect("Boxes", [4], 5134);
  expect("NestedBoxes", [4], 8789);
  expect("Pairs", [4], 909);
  expect("GenericMethods", [4], 61375);
  expect("Chains", [3], 4500210);
  expect("Stores", [4], 32446);
  expect("Constraints", [4], 160017075);
  expect("Casts", [0], 210);
  expect("Casts", [1], 900221);
  expect("Casts", [2], 110);
  trap("BadCast", [], 13);
  expect("Defaults", [4], 2142504);
  expect("Defaults", [-3], 6000000);
  expect("Arrays", [3], 1505);
  expect("Delegates", [4], 5666);
  expect("Closures", [4], 10203);
  expect("LocalFunctions", [4], 702110);
  expect("Nodes", [3], 21);
  expect("DualInterfaces", [], 1126);
  return generics.checks;
}

// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

// Shared by the ordinary, optimized, and alternate-engine Wasm runs. The
// expected values are the CLR's (see tests/differential.mjs).
import { checker } from "./checker.mjs";

export function checkUnions(exports, assert) {
  const unions = checker(exports, assert, "Tests.Unions.Unions.", {
    reset: ["Switches", [1], 30, "unions fault reset"],
  });
  const { expect, trap } = unions;

  expect("Switches", [0], 900);
  expect("Switches", [1], 30);
  expect("Switches", [2], 2);
  expect("Switches", [3], 50);
  expect("Patterns", [3], 1010);
  expect("Patterns", [4], 1100);
  expect("Statements", [0], 9);
  expect("Statements", [4], -2);
  expect("Statements", [2], -3);
  expect("Storage", [6], 100424);
  expect("Payloads", [0], 4);
  expect("Payloads", [5], 5);
  expect("Generic", [4], 4);
  expect("Generic", [-3], -3);
  expect("Closed", [4], 40);
  expect("Closed", [3], 3);
  // The default union matches none of the cases.
  trap("Unmatched", [], 11);
  return unions.checks;
}

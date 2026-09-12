// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

// Shared by the ordinary, optimized, and alternate-engine Wasm runs.
import { checker } from "./checker.mjs";

export function checkStructs(exports, assert) {
  const structs = checker(exports, assert, "Tests.StructTypes.Structs.", {
    reset: ["CopySemantics", [4], 40904, "struct fault reset"],
  });
  const { expect, trap } = structs;

  expect("Vectors", [3], 3058);
  expect("Operators", [3], 3503510);
  expect("Operators", [-1.5], 1201260);
  expect("CopySemantics", [4], 40904);
  expect("Properties", [10], 10066);
  expect("WholeThis", [3], 603);
  expect("Arrays", [4], 400142);
  expect("ArrayInitializer", [7], 7070);
  expect("Fields", [3], -185222373);
  expect("AutoProperty", [4], 101401);
  expect("Nested", [2], 356088);
  expect("Constructors", [5], 11057142);
  expect("MixedFields", [8], 59999);
  expect("Closures", [3], 90609);
  // Static state persists: the second call sees the first's.
  expect("Statics", [2], 204);
  expect("Statics", [3], 508);
  expect("References", [4], 24921296);
  expect("References", [0], -78744);
  expect("RefParameters", [3], 6);
  expect("RefParameters", [9], 14);
  expect("Generic", [3], 6030035);
  expect("Dispatch", [4], 6051900);
  expect("Dispatch", [-3], -948807);
  expect("Conditional", [1], 1220);
  expect("Conditional", [0], 3410);
  expect("Conditional", [5], 1200);
  expect("Temporaries", [3], 303);
  trap("Throws", [3], 17);
  expect("Throws", [-1], -1);
  // A nested store checks its receiver or index before the right-hand side
  // runs.
  trap("NullNestedStore", [], 5);
  expect("Calls", [], 0);
  trap("NullStore", [], 5);
  trap("OutOfRangeStore", [5], 6);
  expect("Calls", [], 0);
  expect("OutOfRangeStore", [1], 0);
  expect("Calls", [], 1);
  return structs.checks;
}

// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

// tests/Construction.cs compiled with --alloc-units 16: structs made in
// place allocate nothing, so loops of a thousand of them (System.Numerics'
// vectors, tuples, records, the transcendentals' double-doubles) finish
// within a budget a single box would exhaust; a constructor that runs
// (a struct with a static constructor) still allocates its box. The values
// themselves are checked against the CLR by tests/differential.mjs.
import { checker } from "./checker.mjs";

export function checkConstructionAllocation(exports, assert) {
  const construction = checker(
    exports,
    assert,
    "Tests.Construction.Construction.",
  );
  const { expect, trap, equal } = construction;
  expect("ManyVectors", [1000], 249750);
  expect("ManyStructs", [1000], 1998000);
  // A local passed `in` is read at once, not boxed for the call.
  expect("ManyInArguments", [1000], 669175);
  expect("Factory", [3], 63);
  const sines = exports["Tests.Construction.Construction.ManySines"](1000);
  equal(exports.__fault.value, 0, "ManySines within the budget");
  equal(typeof sines, "number", "ManySines's value");
  trap("StaticConstructor", [1], 3, "a constructor that runs allocates");
  return construction.checks;
}

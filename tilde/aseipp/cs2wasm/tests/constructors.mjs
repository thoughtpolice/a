// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

// Keep these checks portable across Node/V8, SpiderMonkey, and optimized Wasm.
import { checker } from "./checker.mjs";

export function checkConstructors(exports, assert) {
  // A failed constructor must not poison the next exported call's budgets.
  const constructors = checker(exports, assert, "Tests.Constructors.", {
    reset: ["HelperCall", [], 42, "fault reset"],
  });
  const { expect, trap } = constructors;

  expect("DefaultFields", [], 42);
  expect("HelperCall", [], 42);
  expect("EarlyReturn", [], 0);
  expect("ImplicitDefault", [], 0);
  expect("TypedArguments", [1], 42);
  expect("TypedArguments", [0], 3);
  expect("NestedAllocation", [], 6);
  expect("PositionalArgumentOrder", [], 122);
  expect("NamedArgumentOrder", [], 212);
  expect("InitializerAfterBody", [], 22);
  expect("RecursiveDepth", [0], 0);
  expect("RecursiveDepth", [10], 10);
  trap("BodyFaultBeforeInitializer", [0], 7);
  trap("RecursiveDepth", [1000], 2);
  trap("ExhaustFuel", [], 1);
  trap("ExhaustAllocation", [], 3);
  return constructors.checks;
}

// Compile this variant with --alloc-units 16, below the object's allocation
// cost. Argument evaluation must still happen before the allocation check.
export function checkConstructorAllocationOrder(exports, assert) {
  const constructors = checker(exports, assert, "Tests.Constructors.");
  // Repeated calls must report their own fault, including after allocation
  // failure. The ordinary-budget suite also checks successful calls after traps.
  for (
    const [zero, code] of [
      [0, 7],
      [1, 3],
      [0, 7],
    ]
  ) {
    constructors.trap(
      "ArgumentFaultBeforeAllocation",
      [zero],
      code,
      "constructor argument/allocation order",
    );
  }
  return constructors.checks;
}

// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

// Shared by the ordinary, optimized, and alternate-engine Wasm runs.
import { checker } from "./checker.mjs";

export function checkFieldInitializers(exports, assert) {
  const initializers = checker(exports, assert, "Tests.FieldInitializers.", {
    reset: ["Healthy", [], 42, "initializer fault reset"],
  });
  const { expect, trap } = initializers;

  expect("ImplicitConstructor", [], 740);
  expect("TypedInitializers", [], 37.75);
  expect("FreshReferences", [], 100);
  expect("ExplicitConstructor", [3], 73);
  expect("ExplicitConstructor", [-1], 7);
  expect("ExpressionConstructor", [], 9);
  expect("ObjectInitializer", [25], 25);
  trap("DeclarationOrder", [1], 7);
  trap("MultiDeclarationOrder", [], 5);
  trap("ArgumentBeforeInitializer", [0], 7);
  trap("NullArgumentBeforeInitializer", [], 5);
  trap("InitializerBeforeObjectInitializer", [], 7);
  trap("ImplicitRecursiveDepth", [], 2);
  trap("ExplicitRecursiveDepth", [], 2);
  trap("InitializerFuel", [], 1);
  return initializers.checks;
}

// With a budget below the outer object's size, arguments still run, but field
// initializers must wait until allocation has succeeded.
export function checkFieldInitializerAllocationOrder(exports, assert) {
  const initializers = checker(exports, assert, "Tests.FieldInitializers.");
  for (
    const [name, args, code] of [
      ["DeclarationOrder", [0], 3],
      ["ArgumentBeforeInitializer", [0], 7],
      ["NullArgumentBeforeInitializer", [], 5],
      ["DeclarationOrder", [0], 3],
    ]
  ) {
    initializers.trap(name, args, code, name + " allocation order");
  }
  return initializers.checks;
}

// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

// Shared by the ordinary, optimized, and alternate-engine Wasm runs.
import { checker } from "./checker.mjs";

export function checkInheritance(exports, assert) {
  const inheritance = checker(exports, assert, "Tests.Inheritance.", {
    reset: ["Hiding", [], 4123, "inheritance fault reset"],
  });
  const { expect, trap } = inheritance;

  expect("Areas", [], 3060512);
  for (
    const [kind, expected] of [
      [0, 1200],
      [1, 604],
      [2, 1004],
      [3, 299],
    ]
  ) {
    expect("Describe", [kind], expected);
  }
  for (
    const [kind, expected] of [
      [0, 2012],
      [1, 1012],
      [2, 1019],
      [3, 2003],
    ]
  ) {
    expect("BaseFields", [kind], expected);
  }
  expect("VirtualProperty", [5], 12005);
  expect("ConstructorOrder", [], 3124305);
  expect("ImplicitConstructorOrder", [], 61207);
  expect("Hiding", [], 4123);
  expect("Recursion", [0], 0);
  expect("Recursion", [4], 1004);
  expect("Downcast", [1], 2);
  expect("Downcast", [2], 3);
  trap("Downcast", [0], 13);
  trap("Downcast", [9], 5);
  expect("NullDowncast", [], 1);
  // Per kind: As, IsType, IsPattern, SwitchExpression, SwitchStatement.
  const patterns = [
    [0, -1, 100, 2, 202, 2],
    [1, 3, 1, -2, 102, 4],
    [2, 3, 11, 30, 10, 4],
    [3, -1, 100, -1, 3, -5],
    [9, -1, 0, -1, -1, -1],
  ];
  for (const [kind, ...expected] of patterns) {
    expect("As", [kind], expected[0]);
    expect("IsType", [kind], expected[1]);
    expect("IsPattern", [kind], expected[2]);
    expect("SwitchExpression", [kind], expected[3]);
    expect("SwitchStatement", [kind], expected[4]);
  }
  trap("NullReceiver", [], 5);
  expect("ObjectInitializer", [], 910);
  expect("ExplicitObjectBaseConstructor", [], 3);
  return inheritance.checks;
}

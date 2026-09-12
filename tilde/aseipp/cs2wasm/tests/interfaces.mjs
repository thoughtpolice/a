// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

// Shared by the ordinary, optimized, and alternate-engine Wasm runs.
import { checker } from "./checker.mjs";

export function checkInterfaces(exports, assert) {
  const interfaces = checker(exports, assert, "Tests.Interfaces.", {
    reset: ["BaseInterface", [], 1, "interface fault reset"],
  });
  const { expect, trap } = interfaces;

  expect("Score", [0, 5], 105);
  expect("Score", [1, 5], -5);
  expect("Score", [2, 5], 10);
  trap("Score", [3, 5], 5);
  expect("Entities", [], 37067);
  expect("BaseInterface", [], 1);
  // Per kind: Is, As, Switch.
  for (
    const [kind, ...expected] of [
      [0, 112, 1, 2],
      [1, 0, -1, -7],
      [2, 0, -1, 0],
      [3, 0, -1, -1],
    ]
  ) {
    expect("Is", [kind], expected[0]);
    expect("As", [kind], expected[1]);
    expect("Switch", [kind], expected[2]);
  }
  expect("CastToInterface", [0], 8);
  trap("CastToInterface", [1], 13);
  trap("CastToInterface", [3], 5);
  expect("CastToClass", [1], -1);
  trap("CastToClass", [2], 13);
  expect("Field", [], 42);
  expect("Parameter", [7], 7);
  expect("Identity", [], 111);
  expect("ClassReceiver", [], 10101);
  expect("Unimplemented", [0], -1);
  expect("Unimplemented", [1], 1);
  return interfaces.checks;
}

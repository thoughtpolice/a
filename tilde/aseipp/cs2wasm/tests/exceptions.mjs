// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

// Shared by the ordinary, optimized, and alternate-engine Wasm runs. The
// expected values are the CLR's (see tests/differential.mjs), except for the
// budgets, which the CLR does not have.
import { checker } from "./checker.mjs";

export function checkExceptions(exports, assert) {
  const exceptions = checker(
    exports,
    assert,
    "Tests.ExceptionTypes.Exceptions.",
    {
      reset: ["CatchAll", [0], 1, "exceptions fault reset"],
    },
  );
  const { expect, trap } = exceptions;

  for (
    const [kind, expected] of [
      [0, 1359],
      [1, 1431],
      [2, 1507],
      [3, 1500],
      [4, 16],
      [5, 12],
    ]
  ) {
    expect("CatchTypes", [kind], expected);
  }
  // The log shows each finally running on the way out: after a normal
  // exit, a throw, a return, and a throw from the finally itself.
  expect("FinallyOrder", [0], 1234578);
  expect("FinallyOrder", [1], 124791);
  expect("FinallyOrder", [2], 1247);
  expect("FinallyOrder", [3], 12346793);
  expect("ReturnThroughFinally", [7], 7012);
  expect("LoopsThroughFinally", [6], 501234);
  expect("FinallyReplacesException", [0], 25);
  expect("FinallyReplacesException", [1], 26);
  expect("Rethrow", [0], 1214);
  expect("Rethrow", [1], 1214);
  expect("Rethrow", [2], 1207);
  // A filter that throws is false.
  expect("Filters", [5], 15);
  expect("Filters", [2], 136);
  expect("Filters", [-1], 1327);
  expect("AcrossCalls", [3], 1400338);
  expect("AcrossCalls", [-2], -398657);
  expect("AcrossCalls", [0], 200345);
  // The exceptions compiler checks throw, caught by their classes.
  for (
    const [kind, expected] of [
      [0, 1],
      [1, 2],
      [2, 3],
      [3, 4],
      [4, 5],
      [5, 10],
      [6, 6],
      [7, 10],
      [8, 7],
      [9, 4],
      [10, 8],
      [11, 8],
      [12, 9],
      [13, 4],
    ]
  ) {
    expect("Checks", [kind], expected);
  }
  expect("Hierarchy", [0], 10);
  expect("Hierarchy", [1], 10);
  expect("Hierarchy", [2], 20);
  expect("Hierarchy", [3], 30);
  // What escapes an entry ends it with the exception's code.
  trap("Escapes", [0], 17);
  trap("Escapes", [1], 14);
  trap("Escapes", [2], 17);
  trap("Escapes", [3], 5);
  expect("Escapes", [4], 4);
  expect("ThrowExpressions", [0], -1);
  expect("ThrowExpressions", [3], 6);
  expect("ThrowExpressions", [9], -2);
  expect("Constructors", [-3], -3);
  expect("Constructors", [3], 2);
  // Storage a callee wrote through ref, out or this before throwing keeps
  // the writes.
  expect("MutationsSurvive", [4], 5411);
  expect("Generic", [0], 1);
  expect("Generic", [1], 2);
  expect("Generic", [2], 1);
  expect("Generic", [3], 0);
  expect("CatchAll", [0], 1);
  expect("CatchAll", [1], 1);
  expect("CatchAll", [2], 0);
  expect("InsideCatch", [1], 13502);
  expect("InsideCatch", [7], 1234);
  expect("CapturedCatchVariable", [4], 4);
  // Budgets are not exceptions: no catch or finally runs.
  trap("CatchFuel", [], 1);
  expect("Log", [], 1);
  trap("CatchDepth", [], 2);
  return exceptions.checks;
}

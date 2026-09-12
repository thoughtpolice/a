// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

// Shared by the ordinary, optimized, and alternate-engine Wasm runs. The
// expected values are the CLR's (see tests/differential.mjs): filters run
// before the finally blocks between the throw and the clause chosen.
import { checker } from "./checker.mjs";

export function checkFilters(exports, assert) {
  const filters = checker(exports, assert, "Tests.Filters.Filters.");
  const { expect, trap } = filters;

  expect("BeforeFinally", [2], 8129n);
  expect("Levels", [2], 12990992n);
  expect("Levels", [9], 1234799998n);
  expect("SeesStateBeforeFinally", [1], 2131n);
  expect("ThrowingFilters", [1], 3518129n);
  expect("ThrowingFilters", [4], 351127n);
  expect("AcrossCalls", [3], 412124120n);
  expect("Rethrows", [3], 213546782n);
  expect("Variables", [1], 11111133132n);
  expect("Leaving", [2], 762n);
  expect("FinallyThrowsInside", [1], 1345n);
  expect("Checks", [5], 123n);
  expect("Generic", [1], 40100n);
  // Forty records: the handler stack grows past its first array.
  expect("DeepRecords", [5], 503505360n);
  // A static constructor's exceptions stop at it; the filters outside see
  // only the TypeInitializationException.
  expect("InitializerBoundary", [1], 3246246n);
  expect("InitializerBoundary", [-1], 247247n);
  // Nothing takes it: every filter ran, then every finally block.
  trap("Escapes", [1], 17);
  expect("LastLog", [], 79128n);
  expect("BeforeFinally", [2], 8129n);
  return filters.checks;
}

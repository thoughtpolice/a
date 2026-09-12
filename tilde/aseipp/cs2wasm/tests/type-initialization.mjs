// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

// Shared by the ordinary, optimized, and alternate-engine Wasm runs. The
// expected values are the CLR's (see tests/differential.mjs), in the same
// order: a class is initialized once per instance.
import { checker } from "./checker.mjs";

export function checkTypeInitialization(exports, assert) {
  const broken = checker(exports, assert, "Tests.TypeInitialization.Broken.");
  // A failed initializer's TypeInitializationException escapes with 17,
  // can be caught, and is thrown again at every use.
  broken.trap("Read", [], 17);
  broken.expect("Catch", [], -1);
  broken.trap("Read", [], 17);

  const initialization = checker(
    exports,
    assert,
    "Tests.TypeInitialization.Initialization.",
  );
  const { expect, trap } = initialization;
  expect("StaticMethod", [], 1623452109n);
  expect("FieldAccess", [], 1234144n);
  expect("Construction", [], 60351245n);
  expect("Cycles", [], 211110n);
  expect("Failures", [], 511n);
  expect("FailuresLater", [], 7n);
  trap("FailureEscapes", [], 17);
  expect("FailuresLater", [], 7n);
  expect("FailingFirstUse", [], 123n);
  expect("FailingAgain", [], 9n);
  expect("Nested", [], 456n);
  expect("Nested", [], 56n);
  expect("Structs", [], 712061n);
  expect("Generics", [], 88121n);
  expect("InstanceConstruction", [], 1920n);
  return broken.checks + initialization.checks;
}

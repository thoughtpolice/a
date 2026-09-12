// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

// Host imports that call back into the module's exports while an outer export
// is running. Every entry has its own fuel, depth and allocation budget, and
// the outer call resumes with its own after the nested one returns.
import { checker } from "./checker.mjs";

export function checkReentrancy(module, assert) {
  let seedMode = "throw";
  let target = "Inner";
  const hostError = new Error("seed failed");
  // The imports reach the instance's own exports once it exists.
  const instance = new WebAssembly.Instance(module, {
    test: {
      reenter: (value) => instance.exports["Tests.Reentrancy." + target](value),
      seed() {
        if (seedMode === "throw") throw hostError;
        if (seedMode === "callback") {
          return instance.exports["Tests.Reentrancy.Inner"](3);
        }
        return 42;
      },
    },
  });
  const { exports } = instance;
  const reentrancy = checker(exports, assert, "Tests.Reentrancy.");
  const { equal, expect, trap } = reentrancy;

  // Static initialization calls the `seed` import. A host exception unwinds
  // it without a fault code, so the next entry cannot tell it from a call
  // made during initialization: it is refused once, then initialization runs
  // again.
  assert.throws(
    () => exports["Tests.Reentrancy.Seed"](),
    Error,
    "host exception",
  );
  equal(exports.__fault.value, 0, "a host exception is not a compiler fault");
  seedMode = "plain";
  trap(
    "Seed",
    [],
    12,
    "the entry after an abandoned initialization is refused",
  );
  // An export called back while static initialization runs is refused, not
  // allowed to initialize again or to see half-initialized statics.
  seedMode = "callback";
  trap("Seed", [], 12, "reentry during static initialization");
  seedMode = "plain";
  expect("Seed", [], 42);
  seedMode = "throw";
  expect("Seed", [], 42);

  // Call depth: the outer call keeps its depth across the nested entry,
  // which starts from zero.
  expect("Deep", [40, 60, 23], 60063);
  trap("Deep", [40, 60, 24], 2, "outer depth resumes after a nested entry");
  trap("Deep", [0, 65, 1], 2, "a nested entry has its own depth limit");
  expect("Deep", [40, 1, 23], 1063);

  // Fuel: nested entries neither spend nor refill the outer call's fuel.
  expect("Spin", [50000, 50], 2500000);
  trap("Spin", [150000, 1], 1, "nested entries do not refill outer fuel");

  // Allocation: likewise for the allocation budget.
  target = "AllocateInner";
  expect("Allocate", [100, 100], 10100);
  trap(
    "Allocate",
    [140, 1],
    3,
    "nested entries do not refill the outer budget",
  );
  target = "Inner";

  expect("Inner", [5], 5);
  equal(exports.__fault.value, 0, "successful entry has no fault");
  return reentrancy.checks;
}

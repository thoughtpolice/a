// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

// Host imports that call back into the module's exports while an outer export
// is running. Every entry has its own fuel, depth and allocation budget, and
// the outer call resumes with its own after the nested one returns. Static
// initialization is lazy: an entry nested in an initializer sees it
// partly done, and one a trap stopped is started again.
import { checker } from "./checker.mjs";

export function checkReentrancy(module, assert) {
  let seedMode = "throw";
  let target = "Inner";
  const hostError = new Error("seed failed");
  let spins = 1_000_000;
  let doomedSpins = 1_000_000;
  let swallowed = 0;
  const call = (name, ...args) =>
    instance.exports["Tests.Reentrancy." + name](...args);
  const swallow = (name) => {
    try {
      call(name);
    } catch (error) {
      if (!(error instanceof WebAssembly.RuntimeError)) throw error;
      swallowed++;
    }
  };
  const hooks = {
    1: () => call("ReadPartial"),
    2: () => spins,
    3: () => {
      swallow("SpinnerValue");
      spins = 4;
      return 5;
    },
    4: () => {
      swallow("DoomedValue");
      doomedSpins = 3;
      return call("Inner", 2);
    },
    5: () => doomedSpins,
    6: () => {
      throw hostError;
    },
  };
  // The imports reach the instance's own exports once it exists.
  const instance = new WebAssembly.Instance(module, {
    test: {
      hook: (which) => hooks[which](),
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

  // Static initialization calls the `seed` import. A host exception
  // unwinds it and leaves the class uninitialized; the next use starts
  // again. An initializer is no catch clause for the host's exceptions.
  assert.throws(
    () => exports["Tests.Reentrancy.Seed"](),
    Error,
    "host exception",
  );
  equal(exports.__fault.value, 0, "a host exception is not a compiler fault");
  seedMode = "callback";
  expect("Seed", [], 3);
  seedMode = "throw";
  expect("Seed", [], 3);

  // An entry nested in an initializer sees the fields set so far.
  expect("PartialSeen", [], 7009);
  expect("ReadPartial", [], 709);

  // The host swallows the trap of a nested entry that was initializing a
  // class, and returns: the outer entry initializes the class again.
  expect("SwallowThenUse", [], 5100006);
  equal(swallowed, 1, "the nested entry trapped");
  equal(exports.__fault.value, 0, "the outer entry succeeded");
  expect("SpinnerValue", [], 100006);

  // The host swallows a trap and enters again before returning: the
  // outer entry cannot go on.
  trap("Abandoned", [], 12, "an abandoned entry traps when its import returns");
  equal(swallowed, 2, "the nested entry trapped");
  expect("DoomedValue", [], 100003);

  // Exceptions from the host are not C# exceptions: no catch clause or
  // filter sees one, finally blocks run, and the handler records are
  // restored.
  assert.throws(
    () => exports["Tests.Reentrancy.HostThroughFilters"](),
    Error,
    "host exception",
  );
  equal(exports.__fault.value, 0, "no compiler fault");
  expect("AfterHost", [], 1010);

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

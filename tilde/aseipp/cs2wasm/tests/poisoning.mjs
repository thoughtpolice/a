// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

// A trap poisons a module built by default: every later entry faults with
// 18, as nothing runs in a .NET process after it dies. Exceptions from the
// host do not poison it: the embedder chose to abort that call.
export function checkPoisoning(module, assert) {
  let checks = 0;
  function equal(actual, expected, message) {
    assert.equal(actual, expected, message);
    checks++;
  }

  function create() {
    let throwSeed = false;
    let swallowed = 0;
    const hostError = new Error("host abort");
    const instance = new WebAssembly.Instance(module, {
      test: {
        call(which) {
          const exports = instance.exports;
          if (which === 0) {
            if (throwSeed) throw hostError;
            return 5;
          }
          if (which === 1 || which === 3) {
            // A nested entry traps, and the host swallows the trap.
            try {
              if (which === 1) {
                exports["Tests.Poisoning.Probe.Spin"](1_000_000_000);
              } else exports["Tests.Poisoning.Probe.Throw"](1);
            } catch (error) {
              if (!(error instanceof WebAssembly.RuntimeError)) throw error;
              swallowed++;
            }
            return 3;
          }
          throw hostError;
        },
      },
    });
    const call = (name, ...args) =>
      instance.exports["Tests.Poisoning.Probe." + name](...args);
    const fault = () => instance.exports.__fault.value;
    function trap(name, args, code, message) {
      assert.throws(
        () => call(name, ...args),
        WebAssembly.RuntimeError,
        message,
      );
      equal(fault(), code, message);
    }
    return {
      call,
      fault,
      trap,
      setThrowSeed: (value) => {
        throwSeed = value;
      },
      swallowed: () => swallowed,
      hostError,
    };
  }

  // A budget fault: that entry ends with its code, every later one with 18.
  let module_ = create();
  equal(module_.call("Count"), 1, "a first entry");
  module_.trap("Spin", [1_000_000_000], 1, "fuel runs out");
  module_.trap("Count", [], 18, "poisoned");
  module_.trap("Catch", [], 18, "still poisoned");

  // An exception nothing catches: the entry ends with its code, and the
  // module with it.
  module_ = create();
  equal(module_.call("Catch"), 7, "a caught exception is harmless");
  equal(module_.call("Count"), 1, "and poisons nothing");
  module_.trap("Throw", [1], 14, "an unhandled exception");
  module_.trap("Count", [], 18, "poisoned by the unhandled exception");

  // Exceptions from the host pass through and leave the module usable,
  // and an initializer they stop runs again at the next use.
  module_ = create();
  assert.throws(() => module_.call("CallHost", 2), Error, "a host exception");
  equal(module_.fault(), 0, "no fault code");
  equal(module_.call("Count"), 1, "not poisoned");
  module_.setThrowSeed(true);
  assert.throws(
    () => module_.call("Seed"),
    Error,
    "a host exception in an initializer",
  );
  module_.setThrowSeed(false);
  equal(module_.call("Seed"), 5, "the initializer runs again");

  // A nested entry that traps poisons the module even when the host
  // swallows the trap: the outer entry ends when the import returns.
  module_ = create();
  module_.trap(
    "CallHost",
    [1],
    18,
    "a swallowed nested trap ends the outer entry",
  );
  equal(module_.swallowed(), 1, "the nested entry trapped");
  module_.trap("Count", [], 18, "and the module");
  module_ = create();
  module_.trap(
    "CallHost",
    [3],
    18,
    "a swallowed nested unhandled exception too",
  );
  module_.trap("Count", [], 18, "and the module");
  return checks;
}

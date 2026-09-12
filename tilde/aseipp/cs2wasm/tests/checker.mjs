// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

// Counted assertions over the exports named `prefix + name`, shared by the
// behavior suites. No engine-specific imports: SpiderMonkey loads this too.
//
// `reset` names a call, as [name, args, expected, message], that must succeed
// after every trap with the fault cleared: the next exported call must not
// inherit the failed one's fuel, depth or fault.
export function checker(exports, assert, prefix, { reset } = {}) {
  let checks = 0;
  function equal(actual, expected, message) {
    assert.equal(actual, expected, message);
    checks++;
  }
  function expect(name, args, expected) {
    equal(exports[prefix + name](...args), expected, name);
  }
  function trap(name, args, code, message = name + " fault") {
    assert.throws(
      () => exports[prefix + name](...args),
      WebAssembly.RuntimeError,
      name,
    );
    equal(exports.__fault.value, code, message);
    if (reset) {
      const [resetName, resetArgs, resetExpected, resetMessage] = reset;
      expect(resetName, resetArgs, resetExpected);
      assert.equal(exports.__fault.value, 0, resetMessage);
    }
  }
  return {
    equal,
    expect,
    trap,
    get checks() {
      return checks;
    },
  };
}

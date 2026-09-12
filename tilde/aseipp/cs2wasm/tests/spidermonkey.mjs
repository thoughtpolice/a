// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

// Invoked by integration.mjs using Mozilla's standalone JavaScript shell.
import { suites } from './suites.mjs';

const assert = {
  equal(actual, expected, message = '') {
    assertEq(actual, expected, message);
  },
  throws(action, errorType, message) {
    let thrown;
    try {
      action();
    } catch (error) {
      thrown = error;
    }
    if (!(thrown instanceof errorType)) {
      throw new Error(`${message}: expected ${errorType.name}, got ${thrown}`);
    }
  },
};

function readModule(file) {
  const bytes = read(file, 'binary');
  assert.equal(WebAssembly.validate(bytes), true, `${file}: Wasm validation`);
  const module = new WebAssembly.Module(bytes);
  return module;
}

assert.equal(
  scriptArgs.length,
  suites.length,
  'Expected one module per test suite',
);
let checks = 0;
for (let index = 0; index < suites.length; index++) {
  const suite = suites[index];
  const module = readModule(scriptArgs[index]);
  if (suite.checkModule) {
    checks += suite.checkModule(module, assert);
  } else {
    assert.equal(WebAssembly.Module.imports(module).length, 0);
    checks += suite.check(new WebAssembly.Instance(module).exports, assert);
  }
}
print(`PASS: ${checks} SpiderMonkey behavior checks.`);

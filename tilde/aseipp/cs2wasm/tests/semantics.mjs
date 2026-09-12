// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

// Shared behavior checks for Node/V8, SpiderMonkey, and optimized modules.
// The caller provides assertions so this file has no engine-specific imports.
export function checkCases(exports, assert) {
  let checks = 0;
  function expect(name, args, value) {
    assert.equal(exports['Tests.Cases.' + name](...args), value, name);
    checks++;
  }
  function trap(name, args, code) {
    assert.throws(
      () => exports['Tests.Cases.' + name](...args),
      WebAssembly.RuntimeError,
      name,
    );
    assert.equal(exports.__fault.value, code, name + ' fault');
    checks++;
    expect('Add', [20, 22], 42); // the next entry must reset fuel/depth/fault
    assert.equal(exports.__fault.value, 0, 'fault reset');
  }
  expect('Add', [20, 22], 42);
  expect('Add', [2147483647, 1], -2147483648);
  expect('IntNeg', [-2147483648], -2147483648);
  expect('Shift', [-8, 1], (-8 >> 1) ^ (-8 >>> 1));
  expect('Div', [-7, 3], -2);
  expect('Rem', [-7, 3], -1);
  // Remainder uses the same chosen overflow behavior as division.
  expect('FloatMath', [2, 3], 7.5);
  expect('DoubleMath', [3, 0.25], 3.25);
  expect('Compare', [NaN, 2], 1);
  expect('BoolIdentity', [7], 1);
  expect('Fib', [10], 55);
  expect('Loop', [20], 13);
  expect('WhileLoop', [20], 3);
  expect('GcFields', [39], 42);
  expect('GcArray', [10], 45);
  expect('GcArray', [0], 0);
  expect('ArrayInit', [], 10);
  expect('ArrayRefs', [], 23);
  expect('Jagged', [], 17);
  expect('RefEquality', [], 1);
  expect('ShortCircuit', [], 0);
  expect('RefInequality', [], 1);
  expect('NullEquality', [], 1);
  expect('ArrayEquality', [], 1);
  expect('NamedArgumentOrder', [], 21);
  expect('PostIncrement', [], 45);
  expect('IndexEvaluatedOnce', [], 1001);
  trap('Div', [1, 0], 7);
  trap('Div', [-2147483648, -1], 8);
  trap('Rem', [1, 0], 7);
  trap('Rem', [-2147483648, -1], 8);
  trap('NullAssignmentOrder', [0], 7);
  trap('BoundsAssignmentOrder', [0], 7);
  trap('NullField', [], 5);
  trap('Bounds', [-1], 6);
  trap('Bounds', [2], 6);
  trap('NewLength', [-1], 4);
  trap('NewLength', [65537], 4);
  trap('Infinite', [], 1);
  trap('Recursion', [], 2);
  trap('AllocateForever', [], 3);
  return checks;
}

export function checkGameplay(exports, assert) {
  assert.equal(exports['Demo.Gameplay.SumSquares'](5), 30);
  assert.equal(exports['Demo.Gameplay.VectorLengthSquared'](2, 3, 6), 49);
  return 2;
}

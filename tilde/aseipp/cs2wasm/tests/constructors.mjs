// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

// Keep these checks portable across Node/V8, SpiderMonkey, and optimized Wasm.
export function checkConstructors(exports, assert) {
  let checks = 0;
  function expect(name, args, expected) {
    assert.equal(
      exports['Tests.Constructors.' + name](...args),
      expected,
      name,
    );
    checks++;
  }
  function trap(name, args, code) {
    assert.throws(
      () => exports['Tests.Constructors.' + name](...args),
      WebAssembly.RuntimeError,
      name,
    );
    assert.equal(exports.__fault.value, code, name + ' fault');
    checks++;

    // A failed constructor must not poison the next exported call's budgets.
    expect('HelperCall', [], 42);
    assert.equal(exports.__fault.value, 0, 'fault reset');
  }

  expect('DefaultFields', [], 42);
  expect('HelperCall', [], 42);
  expect('EarlyReturn', [], 0);
  expect('ImplicitDefault', [], 0);
  expect('TypedArguments', [1], 42);
  expect('TypedArguments', [0], 3);
  expect('NestedAllocation', [], 6);
  expect('PositionalArgumentOrder', [], 122);
  expect('NamedArgumentOrder', [], 212);
  expect('InitializerAfterBody', [], 22);
  expect('RecursiveDepth', [0], 0);
  expect('RecursiveDepth', [10], 10);
  trap('BodyFaultBeforeInitializer', [0], 7);
  trap('RecursiveDepth', [1000], 2);
  trap('ExhaustFuel', [], 1);
  trap('ExhaustAllocation', [], 3);
  return checks;
}

// Compile this variant with --alloc-units 16, below the object's allocation
// cost. Argument evaluation must still happen before the allocation check.
export function checkConstructorAllocationOrder(exports, assert) {
  const invoke = exports['Tests.Constructors.ArgumentFaultBeforeAllocation'];
  for (const [zero, code] of [
    [0, 7],
    [1, 3],
    [0, 7],
  ]) {
    assert.throws(() => invoke(zero), WebAssembly.RuntimeError);
    assert.equal(
      exports.__fault.value,
      code,
      'constructor argument/allocation order',
    );
  }

  // Repeated calls must report their own fault, including after allocation
  // failure. The ordinary-budget suite also checks successful calls after traps.
  return 3;
}

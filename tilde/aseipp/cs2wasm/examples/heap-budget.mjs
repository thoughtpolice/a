// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

// Run after ./examples/run-wasmtime.sh has compiled the heap example.
import assert from 'node:assert/strict';
import fs from 'node:fs';

const modulePath = new URL('../publish/heap-gameplay.wasm', import.meta.url);
const { instance } = await WebAssembly.instantiate(fs.readFileSync(modulePath));
const allocate = instance.exports['Demo.HeapGameplay.AllocationPressure'];
const fault = instance.exports.__fault;

try {
  // Each int[1024] costs 8,208 logical allocation units. The 128th allocation
  // exceeds the default 1,048,576-unit budget, even if earlier arrays were freed.
  allocate(128);
  throw new Error('Expected the allocation budget to be exhausted');
} catch (error) {
  if (!(error instanceof WebAssembly.RuntimeError)) {
    throw error;
  }
  assert.equal(fault.value, 3);
  console.log(
    `AllocationPressure(128) trapped: allocation budget exhausted (fault ${fault.value})`,
  );
}

// An exported call starts a fresh execution budget on the same instance.
assert.equal(allocate(1), 1);
assert.equal(fault.value, 0);
console.log(
  'AllocationPressure(1) => 1; the same instance recovered (fault 0)',
);

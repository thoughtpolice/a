// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

// Independent hand-assembled encoding probes, not outputs from the C# compiler.
// These verify the intended Wasm representation and the local VM's GC support.
// They do not verify Roslyn, the compiler API, or Native AOT compatibility.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const valueType = { i32: 0x7f, i64: 0x7e, f32: 0x7d };
const opcode = {
  unreachable: 0x00,
  block: 0x02,
  loop: 0x03,
  if: 0x04,
  end: 0x0b,
  branch: 0x0c,
  branchIf: 0x0d,
  call: 0x10,
  localGet: 0x20,
  localSet: 0x21,
  globalGet: 0x23,
  globalSet: 0x24,
  i32Const: 0x41,
  i64Const: 0x42,
  i32EqualZero: 0x45,
  i32GreaterOrEqualSigned: 0x4e,
  i32GreaterOrEqualUnsigned: 0x4f,
  i64LessThanUnsigned: 0x54,
  i32Add: 0x6a,
  i32Subtract: 0x6b,
  f32Add: 0x92,
  f32Multiply: 0x94,
  refIsNull: 0xd1,
  refEqual: 0xd3,
  gcPrefix: 0xfb,
};
const gcOpcode = {
  structNewDefault: 1,
  structGet: 2,
  structSet: 5,
  arrayNewDefault: 7,
  arrayGet: 11,
  arraySet: 14,
};
const emptyBlockType = 0x40;
const globalIndex = { fuel: 0, depth: 1, allocationBudget: 2, fault: 3 };
const heapIndex = { node: 0, intArray: 1, recursiveNode: 2, vector: 3 };
const referenceTo = (index) => ({ ref: index });

class BinaryWriter {
  bytes = [];

  writeBytes(...bytes) {
    this.bytes.push(...bytes);
    return this;
  }

  writeUnsigned(value) {
    do {
      const byte = value & 0x7f;
      value = Math.floor(value / 128);
      this.writeBytes(byte | (value ? 0x80 : 0));
    } while (value);
    return this;
  }

  writeSigned(value) {
    let remaining = BigInt(value);
    for (;;) {
      const byte = Number(remaining & 0x7fn);
      remaining >>= 7n;
      const signBitSet = (byte & 0x40) !== 0;
      const done =
        (remaining === 0n && !signBitSet) || (remaining === -1n && signBitSet);
      this.writeBytes(byte | (done ? 0 : 0x80));
      if (done) return this;
    }
  }

  writeString(value) {
    const bytes = Buffer.from(value);
    return this.writeUnsigned(bytes.length).writeBytes(...bytes);
  }

  writeSection(id, writePayload) {
    const payload = new BinaryWriter();
    writePayload(payload);
    return this.writeBytes(id)
      .writeUnsigned(payload.bytes.length)
      .writeBytes(...payload.bytes);
  }

  writeValueType(type) {
    if (typeof type === 'number') return this.writeBytes(type);

    // Nullable references use a signed s33 heap type index.
    return this.writeBytes(0x63).writeSigned(type.ref);
  }

  i32Const(value) {
    return this.writeBytes(opcode.i32Const).writeSigned(value);
  }

  i64Const(value) {
    return this.writeBytes(opcode.i64Const).writeSigned(value);
  }

  localGet(index) {
    return this.writeBytes(opcode.localGet).writeUnsigned(index);
  }

  localSet(index) {
    return this.writeBytes(opcode.localSet).writeUnsigned(index);
  }

  globalGet(index) {
    return this.writeBytes(opcode.globalGet).writeUnsigned(index);
  }

  globalSet(index) {
    return this.writeBytes(opcode.globalSet).writeUnsigned(index);
  }

  gc(instruction, ...indices) {
    this.writeBytes(opcode.gcPrefix).writeUnsigned(instruction);
    for (const index of indices) this.writeUnsigned(index);
    return this;
  }

  faultIfTrue(code) {
    return this.writeBytes(opcode.if, emptyBlockType)
      .i32Const(code)
      .globalSet(globalIndex.fault)
      .writeBytes(opcode.unreachable, opcode.end);
  }
}

function assembleModule(heapTypes, functions) {
  const writer = new BinaryWriter().writeBytes(0, 0x61, 0x73, 0x6d, 1, 0, 0, 0);

  writer.writeSection(1, (section) => {
    // The heap types share one recursive group. Function signatures follow it.
    section.writeUnsigned(functions.length + (heapTypes.length ? 1 : 0));
    if (heapTypes.length) {
      section.writeBytes(0x4e).writeUnsigned(heapTypes.length);
      for (const heapType of heapTypes) {
        section.writeBytes(heapType.array ? 0x5e : 0x5f);
        if (!heapType.array) section.writeUnsigned(heapType.fields.length);
        for (const fieldType of heapType.fields) {
          section.writeValueType(fieldType).writeBytes(1); // Mutable field.
        }
      }
    }

    for (const func of functions) {
      section.writeBytes(0x60).writeUnsigned(func.params.length);
      for (const param of func.params) section.writeValueType(param);
      section.writeUnsigned(func.result === null ? 0 : 1);
      if (func.result !== null) section.writeValueType(func.result);
    }
  });

  writer.writeSection(3, (section) => {
    section.writeUnsigned(functions.length);
    functions.forEach((_, index) =>
      section.writeUnsigned(heapTypes.length + index),
    );
  });

  writer.writeSection(6, (section) => {
    const globalTypes = [
      valueType.i32,
      valueType.i32,
      valueType.i64,
      valueType.i32,
    ];
    section.writeUnsigned(globalTypes.length);
    for (const type of globalTypes) {
      section.writeValueType(type).writeBytes(1); // Mutable global.
      if (type === valueType.i64) section.i64Const(0);
      else section.i32Const(0);
      section.writeBytes(opcode.end);
    }
  });

  writer.writeSection(7, (section) => {
    section.writeUnsigned(functions.length + 1);
    functions.forEach((func, index) => {
      section.writeString(func.name).writeBytes(0).writeUnsigned(index);
    });
    section
      .writeString('__fault')
      .writeBytes(3)
      .writeUnsigned(globalIndex.fault);
  });

  writer.writeSection(10, (section) => {
    section.writeUnsigned(functions.length);
    for (const func of functions) {
      const body = new BinaryWriter().writeUnsigned(func.locals.length);
      for (const local of func.locals)
        body.writeUnsigned(1).writeValueType(local);
      body.writeBytes(...func.code.bytes);
      section.writeUnsigned(body.bytes.length).writeBytes(...body.bytes);
    }
  });

  return Uint8Array.from(writer.bytes);
}

const defineFunction = (name, params, result, locals, code) => ({
  name,
  params,
  result,
  locals,
  code,
});
const heapTypes = [
  { fields: [valueType.i32] },
  { array: true, fields: [valueType.i32] },
  { fields: [valueType.i32, referenceTo(heapIndex.recursiveNode)] },
  { fields: [valueType.f32, valueType.f32, valueType.f32] },
];

// Allocate a struct, store 41 in its field, and return the field plus one.
const structCode = new BinaryWriter()
  .gc(gcOpcode.structNewDefault, heapIndex.node)
  .localSet(0)
  .localGet(0)
  .i32Const(41)
  .gc(gcOpcode.structSet, heapIndex.node, 0)
  .localGet(0)
  .gc(gcOpcode.structGet, heapIndex.node, 0)
  .i32Const(1)
  .writeBytes(opcode.i32Add, opcode.end);

// Locals: array = 0, sum = 1, index = 2. Store and sum the values 0 through 9.
const arrayCode = new BinaryWriter()
  .i32Const(10)
  .gc(gcOpcode.arrayNewDefault, heapIndex.intArray)
  .localSet(0)
  .writeBytes(opcode.block, emptyBlockType, opcode.loop, emptyBlockType)
  .localGet(2)
  .i32Const(10)
  .writeBytes(opcode.i32GreaterOrEqualSigned)
  .writeBytes(opcode.branchIf)
  .writeUnsigned(1)
  .localGet(0)
  .localGet(2)
  .localGet(2)
  .gc(gcOpcode.arraySet, heapIndex.intArray)
  .localGet(1)
  .localGet(0)
  .localGet(2)
  .gc(gcOpcode.arrayGet, heapIndex.intArray)
  .writeBytes(opcode.i32Add)
  .localSet(1)
  .localGet(2)
  .i32Const(1)
  .writeBytes(opcode.i32Add)
  .localSet(2)
  .writeBytes(opcode.branch)
  .writeUnsigned(0)
  .writeBytes(opcode.end, opcode.end)
  .localGet(1)
  .writeBytes(opcode.end);

const recursiveNullCode = new BinaryWriter()
  .gc(gcOpcode.structNewDefault, heapIndex.recursiveNode)
  .gc(gcOpcode.structGet, heapIndex.recursiveNode, 1)
  .writeBytes(opcode.refIsNull, opcode.end);

const boundsTrapCode = new BinaryWriter()
  .i32Const(1)
  .gc(gcOpcode.arrayNewDefault, heapIndex.intArray)
  .i32Const(1)
  .gc(gcOpcode.arrayGet, heapIndex.intArray)
  .writeBytes(opcode.end);

// Exhaust a three-iteration fuel budget, recording fault 1 before trapping.
const fuelCode = new BinaryWriter()
  .i32Const(0)
  .globalSet(globalIndex.fault)
  .i32Const(3)
  .globalSet(globalIndex.fuel)
  .writeBytes(opcode.loop, emptyBlockType)
  .globalGet(globalIndex.fuel)
  .writeBytes(opcode.i32EqualZero)
  .faultIfTrue(1)
  .globalGet(globalIndex.fuel)
  .i32Const(1)
  .writeBytes(opcode.i32Subtract)
  .globalSet(globalIndex.fuel)
  .writeBytes(opcode.branch)
  .writeUnsigned(0)
  .writeBytes(opcode.end, opcode.end);

const allocationTrapCode = new BinaryWriter()
  .i32Const(0)
  .globalSet(globalIndex.fault)
  .i64Const(16)
  .globalSet(globalIndex.allocationBudget)
  .globalGet(globalIndex.allocationBudget)
  .i64Const(24)
  .writeBytes(opcode.i64LessThanUnsigned)
  .faultIfTrue(3)
  .writeBytes(opcode.end);

// Function 7 is DepthRecurse. DepthEntry resets the budget before calling it.
const depthEntryCode = new BinaryWriter()
  .i32Const(0)
  .globalSet(globalIndex.fault)
  .i32Const(0)
  .globalSet(globalIndex.depth)
  .writeBytes(opcode.call)
  .writeUnsigned(7)
  .writeBytes(opcode.end);

const depthRecurseCode = new BinaryWriter()
  .globalGet(globalIndex.depth)
  .i32Const(4)
  .writeBytes(opcode.i32GreaterOrEqualUnsigned)
  .faultIfTrue(2)
  .globalGet(globalIndex.depth)
  .i32Const(1)
  .writeBytes(opcode.i32Add)
  .globalSet(globalIndex.depth)
  .writeBytes(opcode.call)
  .writeUnsigned(7)
  .globalGet(globalIndex.depth)
  .i32Const(1)
  .writeBytes(opcode.i32Subtract)
  .globalSet(globalIndex.depth)
  .writeBytes(opcode.end);

const referenceIdentityCode = new BinaryWriter()
  .gc(gcOpcode.structNewDefault, heapIndex.recursiveNode)
  .localSet(0)
  .localGet(0)
  .localGet(0)
  .writeBytes(opcode.refEqual, opcode.end);

// Parameters occupy locals 0..2; local 3 holds the vector struct.
const vectorCode = new BinaryWriter()
  .gc(gcOpcode.structNewDefault, heapIndex.vector)
  .localSet(3);
for (let fieldIndex = 0; fieldIndex < 3; fieldIndex++) {
  vectorCode
    .localGet(3)
    .localGet(fieldIndex)
    .gc(gcOpcode.structSet, heapIndex.vector, fieldIndex);
}
for (let fieldIndex = 0; fieldIndex < 3; fieldIndex++) {
  vectorCode
    .localGet(3)
    .gc(gcOpcode.structGet, heapIndex.vector, fieldIndex)
    .localGet(3)
    .gc(gcOpcode.structGet, heapIndex.vector, fieldIndex)
    .writeBytes(opcode.f32Multiply);
  if (fieldIndex > 0) vectorCode.writeBytes(opcode.f32Add);
}
vectorCode.writeBytes(opcode.end);

const functions = [
  defineFunction(
    'Struct42',
    [],
    valueType.i32,
    [referenceTo(heapIndex.node)],
    structCode,
  ),
  defineFunction(
    'Array45',
    [],
    valueType.i32,
    [referenceTo(heapIndex.intArray), valueType.i32, valueType.i32],
    arrayCode,
  ),
  defineFunction('RecursiveNull', [], valueType.i32, [], recursiveNullCode),
  defineFunction('BuiltinBoundsTrap', [], valueType.i32, [], boundsTrapCode),
  defineFunction('FuelTrap', [], null, [], fuelCode),
  defineFunction('AllocationTrap', [], null, [], allocationTrapCode),
  defineFunction('DepthEntry', [], null, [], depthEntryCode),
  defineFunction('DepthRecurse', [], null, [], depthRecurseCode),
  defineFunction(
    'RefIdentity',
    [],
    valueType.i32,
    [referenceTo(heapIndex.recursiveNode)],
    referenceIdentityCode,
  ),
  defineFunction(
    'VectorLengthSquared',
    [valueType.f32, valueType.f32, valueType.f32],
    valueType.f32,
    [referenceTo(heapIndex.vector)],
    vectorCode,
  ),
];

const bytes = assembleModule(heapTypes, functions);
assert.equal(WebAssembly.validate(bytes), true);
const compiledModule = new WebAssembly.Module(bytes);
const exports = new WebAssembly.Instance(compiledModule, {}).exports;
let checks = 0;

function pass(label, check) {
  check();
  checks++;
  console.log(`PASS encoding: ${label}`);
}

pass('GC struct new/get/set', () => assert.equal(exports.Struct42(), 42));
pass('GC array + structured loop', () => assert.equal(exports.Array45(), 45));
pass('recursive GC type + null default', () =>
  assert.equal(exports.RecursiveNull(), 1),
);
pass('built-in array bounds trap', () => {
  assert.throws(() => exports.BuiltinBoundsTrap(), WebAssembly.RuntimeError);
});
pass('control fuel trap', () => {
  assert.throws(() => exports.FuelTrap(), WebAssembly.RuntimeError);
  assert.equal(exports.__fault.value, 1);
});
pass('allocation accounting trap', () => {
  assert.throws(() => exports.AllocationTrap(), WebAssembly.RuntimeError);
  assert.equal(exports.__fault.value, 3);
});
pass('call-depth trap', () => {
  assert.throws(() => exports.DepthEntry(), WebAssembly.RuntimeError);
  assert.equal(exports.__fault.value, 2);
});
pass('reference identity', () => assert.equal(exports.RefIdentity(), 1));
pass('float GC fields', () =>
  assert.equal(exports.VectorLengthSquared(2, 3, 6), 49),
);
pass('no imports or exposed memory/table', () => {
  assert.deepEqual(WebAssembly.Module.imports(compiledModule), []);
  const exposesMemoryOrTable = WebAssembly.Module.exports(compiledModule).some(
    (exported) => exported.kind === 'memory' || exported.kind === 'table',
  );
  assert.equal(exposesMemoryOrTable, false);
});

// Index 64 requires a second signed LEB byte; a one-byte value means -64.
const wideHeapTypes = Array.from({ length: 65 }, () => ({ fields: [] }));
const wideHeapCode = new BinaryWriter()
  .gc(gcOpcode.structNewDefault, 64)
  .localSet(0)
  .localGet(0)
  .writeBytes(opcode.refIsNull, opcode.end);
const wideBytes = assembleModule(wideHeapTypes, [
  defineFunction(
    'SignedHeapIndex64',
    [],
    valueType.i32,
    [referenceTo(64)],
    wideHeapCode,
  ),
]);

pass('signed s33 heap index >= 64', () => {
  const wideModule = new WebAssembly.Module(wideBytes);
  const wideExports = new WebAssembly.Instance(wideModule).exports;
  assert.equal(wideExports.SignedHeapIndex64(), 0);
});
pass('binary version is 1, not 3', () => {
  const invalidVersionBytes = bytes.slice();
  invalidVersionBytes[4] = 3;
  assert.equal(WebAssembly.validate(invalidVersionBytes), false);
});

const output = fs.mkdtempSync(path.join(os.tmpdir(), 'gameplayc-encoding-'));
console.log(`Encoding probes: ${output}`);
fs.writeFileSync(path.join(output, 'gc-probe.wasm'), bytes);
fs.writeFileSync(path.join(output, 'wide-type-probe.wasm'), wideBytes);
fs.writeFileSync(
  path.join(output, 'result.json'),
  JSON.stringify(
    {
      provenance:
        'Hand-assembled JavaScript encoding probes; NOT compiled from C#.',
      node: process.versions.node,
      v8: process.versions.v8,
      passed: checks,
      csharpCompilerBuilt: false,
      nativeAotPublished: false,
    },
    null,
    2,
  ) + '\n',
);
console.log(
  `PASS: ${checks} independent encoding probes (hand-assembled Wasm only).`,
);

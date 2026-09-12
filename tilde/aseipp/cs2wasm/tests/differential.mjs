// Compare actual CLR execution with native gameplayc output for identical C#.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const [compilerArgument, ...options] = process.argv.slice(2);
const seedOption = options.find((option) => option.startsWith('--seed='));
const seed = seedOption
  ? Number(seedOption.slice('--seed='.length))
  : 0x5eed1234;
if (
  !compilerArgument ||
  options.length > (seedOption ? 1 : 0) ||
  !Number.isInteger(seed) ||
  seed < 0 ||
  seed > 0xffffffff
) {
  throw new Error(
    'Usage: node tests/differential.mjs ./publish/gameplayc [--seed=0x5eed1234]',
  );
}

const output = path.join(root, 'publish/differential');
const nativeDirectory = path.join(output, 'native');
const managedDirectory = path.join(output, 'managed');
fs.mkdirSync(nativeDirectory, { recursive: true });
const executable = path.join(
  nativeDirectory,
  process.platform === 'win32' ? 'gameplayc.exe' : 'gameplayc',
);
fs.copyFileSync(path.resolve(compilerArgument), executable);
fs.chmodSync(executable, 0o755);

function run(command, args, environment = process.env) {
  const result = spawnSync(command, args, {
    cwd: root,
    env: environment,
    encoding: 'utf8',
    timeout: 120_000,
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  assert.equal(
    result.status,
    0,
    `${command} ${args.join(' ')}\n${result.stdout}\n${result.stderr}`,
  );
  return result.stdout;
}

// The reference uses the installed SDK; the copied native compiler cannot.
const nativeEnvironment = {
  ...process.env,
  PATH: '',
  DOTNET_ROOT: path.join(nativeDirectory, 'no-sdk'),
  DOTNET_ROOT_X64: path.join(nativeDirectory, 'no-sdk'),
  DOTNET_ROOT_ARM64: path.join(nativeDirectory, 'no-sdk'),
  DOTNET_MULTILEVEL_LOOKUP: '0',
};
assert.match(run(executable, ['--info'], nativeEnvironment), /native-aot=True/);

const modules = [
  { name: 'operations', source: 'tests/Differential.cs' },
  { name: 'constructors', source: 'tests/Constructors.cs' },
  { name: 'field-initializers', source: 'tests/FieldInitializers.cs' },
  { name: 'syntax', source: 'tests/Syntax.cs' },
  { name: 'heap', source: 'examples/HeapGameplay.cs' },
];
const instances = new Map();
for (const module of modules) {
  const wasm = path.join(output, `${module.name}.wasm`);
  run(
    executable,
    ['-o', wasm, path.join(root, module.source)],
    nativeEnvironment,
  );
  const bytes = fs.readFileSync(wasm);
  assert.equal(
    WebAssembly.validate(bytes),
    true,
    `${module.source}: valid Wasm`,
  );
  instances.set(
    module.name,
    new WebAssembly.Instance(new WebAssembly.Module(bytes)).exports,
  );
}

const cases = [];
function inputText(value) {
  return Object.is(value, -0) ? '-0' : String(value);
}
function add(module, type, method, args = [], policy = null) {
  cases.push({
    module,
    method: `${type}.${method}`,
    args: args.map(inputText),
    policy,
  });
}
const operation = (method, args = [], policy = null) =>
  add('operations', 'Differential.Operations', method, args, policy);
const constructor = (method, args = [], policy = null) =>
  add('constructors', 'Tests.Constructors', method, args, policy);
const initializer = (method, args = []) =>
  add('field-initializers', 'Tests.FieldInitializers', method, args);
const syntax = (method, args = [], policy = null) =>
  add('syntax', 'Tests.Syntax', method, args, policy);
const heap = (method, args = [], policy = null) =>
  add('heap', 'Demo.HeapGameplay', method, args, policy);

let randomState = seed;
function randomInt() {
  // Mulberry32 with an explicit seed makes every failing input reproducible.
  randomState = (randomState + 0x6d2b79f5) | 0;
  let value = Math.imul(randomState ^ (randomState >>> 15), 1 | randomState);
  value ^= value + Math.imul(value ^ (value >>> 7), 61 | value);
  return (value ^ (value >>> 14)) | 0;
}
function bounded(limit) {
  return (randomInt() >>> 0) % limit;
}

const integerBoundaries = [
  -2147483648, -2147483647, -65536, -33, -32, -31, -1, 0, 1, 2, 30, 31, 32, 33,
  65535, 16777217, 2147483646, 2147483647,
];
function integerPair(left, right) {
  for (const method of [
    'Add',
    'Subtract',
    'Multiply',
    'Divide',
    'Remainder',
    'ShiftLeft',
    'ShiftRight',
    'ShiftUnsigned',
    'IntegerCompare',
  ]) {
    operation(method, [left, right]);
  }
}
for (const left of integerBoundaries) {
  operation('Negate', [left]);
  operation('IntegerToFloat', [left]);
  operation('IntegerToDouble', [left]);
  for (const right of integerBoundaries) integerPair(left, right);
}
for (let index = 0; index < 256; index++) {
  integerPair(randomInt(), randomInt());
}
for (const left of [0, 1]) {
  for (const right of [0, 1]) operation('BooleanExpression', [left, right]);
}

const floatingBoundaries = [
  -Infinity,
  -Number.MAX_VALUE,
  -3.4028234663852886e38,
  -16777217,
  -1.5,
  -Number.MIN_VALUE,
  -0,
  0,
  Number.MIN_VALUE,
  1.401298464324817e-45,
  1.5,
  16777217,
  3.4028234663852886e38,
  Number.MAX_VALUE,
  Infinity,
  NaN,
];
for (const left of floatingBoundaries) {
  for (const method of ['FloatNegate', 'DoubleNegate', 'Narrow', 'Widen']) {
    operation(method, [left]);
  }
  for (const right of floatingBoundaries) {
    for (const method of [
      'FloatAdd',
      'FloatMultiply',
      'FloatDivide',
      'DoubleAdd',
      'DoubleMultiply',
      'DoubleDivide',
      'DoubleLess',
      'DoubleEqual',
      'DoubleNotEqual',
    ]) {
      operation(method, [left, right]);
    }
  }
}

operation('NullRead');
operation('AssignmentOrder');
for (const denominator of [0, 1]) {
  operation('NullAssignmentOrder', [denominator]);
  operation('BoundsAssignmentOrder', [denominator]);
}
for (const index of [-2147483648, -1, 0, 1, 2, 3, 2147483647]) {
  operation('ArrayRead', [index]);
}
for (const length of [-1, 0, 1, 32, 65536]) operation('ArrayLength', [length]);
operation('ArrayLength', [65537], {
  fault: 4,
  reason: 'The configured maximum array length has no CLR counterpart.',
});
for (let index = 0; index < 64; index++) {
  operation('PostIncrementOrder', [randomInt()]);
  operation('HeapAliases', [randomInt()]);
}

for (const method of [
  'DefaultFields',
  'HelperCall',
  'EarlyReturn',
  'ImplicitDefault',
  'NestedAllocation',
  'PositionalArgumentOrder',
  'NamedArgumentOrder',
  'InitializerAfterBody',
]) {
  constructor(method);
}
constructor('TypedArguments', [0]);
constructor('TypedArguments', [1]);
constructor('BodyFaultBeforeInitializer', [0]);
constructor('BodyFaultBeforeInitializer', [1]);
for (const depth of [0, 1, 10, 30]) constructor('RecursiveDepth', [depth]);
constructor('RecursiveDepth', [100], {
  fault: 2,
  reason: 'The compiler imposes a logical call-depth limit.',
});

for (const method of [
  'ImplicitConstructor',
  'TypedInitializers',
  'FreshReferences',
  'ExpressionConstructor',
  'MultiDeclarationOrder',
  'NullArgumentBeforeInitializer',
  'InitializerBeforeObjectInitializer',
]) {
  initializer(method);
}
for (const value of [-2147483648, -1, 0, 1, 3, 2147483647]) {
  initializer('ExplicitConstructor', [value]);
  initializer('ObjectInitializer', [value]);
}
initializer('DeclarationOrder', [1]);
initializer('ArgumentBeforeInitializer', [0]);
initializer('ArgumentBeforeInitializer', [1]);

function compoundPair(left, right) {
  for (const method of [
    'Arithmetic',
    'AddAssignment',
    'DivideAssignment',
    'RemainderAssignment',
    'LeftShiftAssignment',
    'RightShiftAssignment',
    'UnsignedShiftAssignment',
    'Bitwise',
    'AssignmentValue',
  ]) {
    syntax(method, [left, right]);
  }
}
for (const left of integerBoundaries) {
  for (const right of integerBoundaries) compoundPair(left, right);
}
for (let index = 0; index < 64; index++) compoundPair(randomInt(), randomInt());
for (const left of floatingBoundaries) {
  for (const right of floatingBoundaries) {
    syntax('FloatArithmetic', [left, right]);
    syntax('DoubleArithmetic', [left, right]);
  }
  syntax('MixedArithmetic', [left, randomInt()]);
}
for (const value of [0, 1]) {
  syntax('BooleanEager', [value]);
  syntax('NullCompoundOrder', [value]);
  syntax('NullArrayCompoundOrder', [value]);
  syntax('BoundsCompoundOrder', [value]);
  syntax('IndexFaultBeforeNull', [value]);
}
for (const method of [
  'FieldEvaluationOrder',
  'ArrayEvaluationOrder',
  'NestedAssignment',
  'ForeachControl',
  'ForeachNested',
  'ForeachCollectionOnce',
  'ForeachMutation',
  'ForeachReferences',
  'ForeachJagged',
  'ForeachWidening',
  'ForeachFloatConversion',
  'ForeachBooleans',
  'ForeachNull',
]) {
  syntax(method);
}
for (const length of [0, 1, 2, 17, 100]) syntax('ForeachSum', [length]);
for (const wanted of [0, 3, 7, 11, 12]) syntax('ForeachEarlyReturn', [wanted]);
syntax('ForeachFuel', [], {
  fault: 1,
  reason: "Finite loops can exceed the compiler's control-step fuel budget.",
});
syntax('ForeachSum', [3]);

for (let index = 0; index < 64; index++) {
  heap('ParticleSimulation', [bounded(16), bounded(12)]);
  heap('SharedGraphWeight', [randomInt()]);
}
heap('ParticleSimulation', [-1, 0]);
heap('ParticleSimulation', [1, -1]);
for (let y = -1; y <= 5; y++) {
  for (let x = -1; x <= 7; x++) heap('MazeDistance', [x, y]);
}
for (const count of [0, 1, 2, 10, 127]) heap('AllocationPressure', [count]);
heap('AllocationPressure', [128], {
  fault: 3,
  reason: 'Cumulative allocation charging is independent of CLR collection.',
});
heap('AllocationPressure', [1]); // A normal entry must recover after the fault.

const requestsFile = path.join(output, 'requests.json');
fs.writeFileSync(requestsFile, JSON.stringify(cases, null, 2) + '\n');
console.log(`Differential seed: 0x${seed.toString(16).padStart(8, '0')}`);
process.stdout.write(
  run('dotnet', [
    'build',
    path.join(root, 'tests/reference/Reference.csproj'),
    '-c',
    'Release',
    '--artifacts-path',
    managedDirectory,
    '--nologo',
  ]),
);
const oracle = path.join(
  managedDirectory,
  'bin/Reference/release/Gameplay.Reference.dll',
);
const referenceOutput = run('dotnet', [oracle, requestsFile]);
fs.writeFileSync(path.join(output, 'reference.jsonl'), referenceOutput);
const reference = referenceOutput
  .trim()
  .split(/\r?\n/)
  .map((line) => JSON.parse(line));
assert.equal(reference.length, cases.length, 'One CLR result for each request');

function encodeWasmValue(value, referenceValue) {
  if (referenceValue === 'void') {
    assert.equal(value, undefined);
    return 'void';
  }
  assert.equal(typeof value, 'number');
  if (referenceValue.startsWith('i32:')) return `i32:${value}`;
  if (Number.isNaN(value)) return 'f64:NaN';
  const bits = new DataView(new ArrayBuffer(8));
  bits.setFloat64(0, value, false);
  return 'f64:' + bits.getBigUint64(0, false).toString(16).padStart(16, '0');
}

function expectedFault(test, outcome) {
  switch (outcome.Exception) {
    case 'NullReferenceException':
      return 5;
    case 'IndexOutOfRangeException':
      return 6;
    case 'DivideByZeroException':
      return 7;
    case 'OverflowException':
      return test.method === 'Differential.Operations.ArrayLength' ? 4 : 8;
    default:
      throw new Error(`Unmapped CLR exception: ${outcome.Exception}`);
  }
}

let equalValues = 0;
let equalFaults = 0;
let policyChecks = 0;
for (let index = 0; index < cases.length; index++) {
  const test = cases[index];
  const expected = reference[index];
  const exports = instances.get(test.module);
  const context =
    `seed=0x${seed.toString(16)} case=${index} ` +
    `${test.method}(${test.args.join(', ')})`;
  try {
    const invoke = exports[test.method];
    assert.equal(typeof invoke, 'function', 'Export exists');
    let value;
    let trapped = false;
    try {
      value = invoke(...test.args.map(Number));
    } catch (error) {
      assert.ok(
        error instanceof WebAssembly.RuntimeError,
        'Expected a Wasm trap',
      );
      trapped = true;
    }

    if (test.policy) {
      // Each exception to CLR equivalence is attached to one concrete input.
      // Require actual successful CLR execution and the documented Wasm fault.
      assert.equal(expected.Kind, 'value', test.policy.reason);
      assert.equal(trapped, true, test.policy.reason);
      assert.equal(
        exports.__fault.value,
        test.policy.fault,
        test.policy.reason,
      );
      policyChecks++;
    } else if (expected.Kind === 'exception') {
      assert.equal(trapped, true, `CLR threw ${expected.Exception}`);
      assert.equal(exports.__fault.value, expectedFault(test, expected));
      equalFaults++;
    } else {
      assert.equal(
        trapped,
        false,
        `CLR returned ${expected.Value}; Wasm fault=${exports.__fault.value}`,
      );
      assert.equal(exports.__fault.value, 0, 'Success resets the fault state');
      assert.equal(encodeWasmValue(value, expected.Value), expected.Value);
      equalValues++;
    }
  } catch (error) {
    throw new Error(`${context}\n${error.message}\nArtifacts: ${output}`, {
      cause: error,
    });
  }
}

console.log(
  `PASS: ${equalValues} CLR/Wasm values, ${equalFaults} matching runtime faults, ` +
    `${policyChecks} explicit runtime-policy checks across ${modules.length} C# modules.`,
);

// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

// Compare actual CLR execution with native gameplayc output for identical C#.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { isolateCompiler } from "./compiler.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const arguments_ = process.argv.slice(2);
const seedOption = arguments_.find((option) => option.startsWith("--seed="));
const command = arguments_.filter((argument) => argument !== seedOption);
const seed = seedOption
  ? Number(seedOption.slice("--seed=".length))
  : 0x5eed1234;
if (
  command.length === 0 ||
  command.some((argument) => argument.startsWith("--")) ||
  !Number.isInteger(seed) ||
  seed < 0 ||
  seed > 0xffffffff
) {
  throw new Error(
    "Usage: deno run --allow-all tests/differential.mjs <compiler command...> [--seed=0x5eed1234]; " +
      "GAMEPLAYC_REFERENCE names the CLR oracle executable",
  );
}

const output = fs.mkdtempSync(
  path.join(os.tmpdir(), "gameplayc-differential-"),
);
// Scratch files are removed when the run ends; set GAMEPLAYC_KEEP_ARTIFACTS to
// keep them for inspection.
const keepArtifacts = Boolean(process.env.GAMEPLAYC_KEEP_ARTIFACTS);

try {
  function run(command, args, environment = process.env) {
    // No working directory of its own: a JIT compiler command names its files
    // relative to the caller's, and every path handed over here is absolute.
    const result = spawnSync(command, args, {
      env: environment,
      encoding: "utf8",
      timeout: 120_000,
      maxBuffer: 16 * 1024 * 1024,
    });
    if (result.error) throw result.error;
    assert.equal(
      result.status,
      0,
      `${command} ${args.join(" ")}\n${result.stdout}\n${result.stderr}`,
    );
    return result.stdout;
  }

  // A single executable is the Native AOT deliverable and runs isolated. A
  // longer command, such as the JIT layout's `dotnet exec gameplayc.dll`, runs
  // as it is. The reference always uses the installed SDK.
  let compiler = command;
  let compilerEnvironment = process.env;
  if (command.length === 1) {
    const { executable, environment } = isolateCompiler(
      command[0],
      path.join(output, "native"),
    );
    compiler = [executable];
    compilerEnvironment = environment;
    assert.match(
      run(executable, ["--info"], compilerEnvironment),
      /native-aot=True/,
    );
  }
  function compile(args) {
    return run(
      compiler[0],
      [...compiler.slice(1), ...args],
      compilerEnvironment,
    );
  }

  // The features module reads one host value during static initialization,
  // for a class (Lazy) the CLR never loads here; any nonzero answer lets the
  // Wasm module's eager initialization complete.
  const modules = [
    { name: "operations", source: "tests/Differential.cs" },
    { name: "constructors", source: "tests/Constructors.cs" },
    { name: "field-initializers", source: "tests/FieldInitializers.cs" },
    { name: "syntax", source: "tests/Syntax.cs" },
    { name: "heap", source: "examples/HeapGameplay.cs" },
    {
      name: "features",
      source: "tests/Features.cs",
      imports: { features: { read: () => 5 } },
    },
  ];
  const instances = new Map();
  for (const module of modules) {
    const wasm = path.join(output, `${module.name}.wasm`);
    compile(["-o", wasm, path.join(root, module.source)]);
    const bytes = fs.readFileSync(wasm);
    assert.equal(
      WebAssembly.validate(bytes),
      true,
      `${module.source}: valid Wasm`,
    );
    instances.set(
      module.name,
      new WebAssembly.Instance(new WebAssembly.Module(bytes), module.imports)
        .exports,
    );
  }

  const cases = [];
  // The values handed to Wasm (numbers, or BigInts for i64 parameters); the
  // request file carries their decimal spellings for the oracle.
  const inputs = [];
  function inputText(value) {
    return Object.is(value, -0) ? "-0" : String(value);
  }
  function add(module, type, method, args = [], policy = null) {
    cases.push({
      module,
      method: `${type}.${method}`,
      args: args.map(inputText),
      policy,
    });
    inputs.push(args);
  }
  const operation = (method, args = [], policy = null) =>
    add("operations", "Differential.Operations", method, args, policy);
  const numeric = (method, args = [], policy = null) =>
    add("operations", "Differential.Numerics", method, args, policy);
  const constructor = (method, args = [], policy = null) =>
    add("constructors", "Tests.Constructors", method, args, policy);
  const initializer = (method, args = []) =>
    add("field-initializers", "Tests.FieldInitializers", method, args);
  const syntax = (method, args = [], policy = null) =>
    add("syntax", "Tests.Syntax", method, args, policy);
  const heap = (method, args = [], policy = null) =>
    add("heap", "Demo.HeapGameplay", method, args, policy);
  const feature = (type, method, args = [], policy = null) =>
    add("features", `Tests.${type}`, method, args, policy);

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
    -2147483648,
    -2147483647,
    -65536,
    -33,
    -32,
    -31,
    -1,
    0,
    1,
    2,
    30,
    31,
    32,
    33,
    65535,
    16777217,
    2147483646,
    2147483647,
  ];
  function integerPair(left, right) {
    for (
      const method of [
        "Add",
        "Subtract",
        "Multiply",
        "Divide",
        "Remainder",
        "ShiftLeft",
        "ShiftRight",
        "ShiftUnsigned",
        "IntegerCompare",
      ]
    ) {
      operation(method, [left, right]);
    }
  }
  for (const left of integerBoundaries) {
    operation("Negate", [left]);
    operation("IntegerToFloat", [left]);
    operation("IntegerToDouble", [left]);
    for (const right of integerBoundaries) integerPair(left, right);
  }
  for (let index = 0; index < 256; index++) {
    integerPair(randomInt(), randomInt());
  }
  for (const left of [0, 1]) {
    for (const right of [0, 1]) operation("BooleanExpression", [left, right]);
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
    for (const method of ["FloatNegate", "DoubleNegate", "Narrow", "Widen"]) {
      operation(method, [left]);
    }
    for (const right of floatingBoundaries) {
      for (
        const method of [
          "FloatAdd",
          "FloatMultiply",
          "FloatDivide",
          "DoubleAdd",
          "DoubleMultiply",
          "DoubleDivide",
          "DoubleLess",
          "DoubleEqual",
          "DoubleNotEqual",
        ]
      ) {
        operation(method, [left, right]);
      }
    }
  }

  operation("NullRead");
  operation("AssignmentOrder");
  for (const denominator of [0, 1]) {
    operation("NullAssignmentOrder", [denominator]);
    operation("BoundsAssignmentOrder", [denominator]);
  }
  for (const index of [-2147483648, -1, 0, 1, 2, 3, 2147483647]) {
    operation("ArrayRead", [index]);
  }
  for (const length of [-1, 0, 1, 32, 65536]) {
    operation("ArrayLength", [length]);
  }
  operation("ArrayLength", [65537], {
    fault: 4,
    reason: "The configured maximum array length has no CLR counterpart.",
  });
  for (const length of [-(2n ** 63n), -1n, 0n, 3n, 65536n]) {
    operation("LongArrayLength", [length]);
  }
  operation("LongArrayLength", [65537n], {
    fault: 4,
    reason: "The configured maximum array length has no CLR counterpart.",
  });
  for (const length of [0n, 3n, 65536n, 2n ** 63n, 2n ** 64n - 1n]) {
    operation("ULongArrayLength", [length]);
  }
  for (const index of [0, 2, 3, 2147483648, 4294967295]) {
    operation("UIntArrayRead", [index]);
  }
  const wideIndices = [
    -(2n ** 63n),
    -(2n ** 32n) + 1n,
    -1n,
    0n,
    2n,
    3n,
    2n ** 31n - 1n,
    2n ** 31n,
    2n ** 32n + 1n,
    2n ** 63n - 1n,
  ];
  for (const index of wideIndices) {
    operation("LongArrayRead", [index]);
    operation("LongArrayWrite", [index, 7]);
    operation("LongNullRead", [index]);
  }
  for (
    const index of [
      0n,
      2n,
      3n,
      2n ** 32n + 1n,
      2n ** 63n - 1n,
      2n ** 63n,
      2n ** 64n - 1n,
    ]
  ) {
    operation("ULongArrayRead", [index]);
    operation("ULongNullRead", [index]);
  }
  for (let index = 0; index < 64; index++) {
    operation("PostIncrementOrder", [randomInt()]);
    operation("HeapAliases", [randomInt()]);
  }

  for (
    const method of [
      "DefaultFields",
      "HelperCall",
      "EarlyReturn",
      "ImplicitDefault",
      "NestedAllocation",
      "PositionalArgumentOrder",
      "NamedArgumentOrder",
      "InitializerAfterBody",
    ]
  ) {
    constructor(method);
  }
  constructor("TypedArguments", [0]);
  constructor("TypedArguments", [1]);
  constructor("BodyFaultBeforeInitializer", [0]);
  constructor("BodyFaultBeforeInitializer", [1]);
  for (const depth of [0, 1, 10, 30]) constructor("RecursiveDepth", [depth]);
  constructor("RecursiveDepth", [100], {
    fault: 2,
    reason: "The compiler imposes a logical call-depth limit.",
  });

  for (
    const method of [
      "ImplicitConstructor",
      "TypedInitializers",
      "FreshReferences",
      "ExpressionConstructor",
      "MultiDeclarationOrder",
      "NullArgumentBeforeInitializer",
      "InitializerBeforeObjectInitializer",
    ]
  ) {
    initializer(method);
  }
  for (const value of [-2147483648, -1, 0, 1, 3, 2147483647]) {
    initializer("ExplicitConstructor", [value]);
    initializer("ObjectInitializer", [value]);
  }
  initializer("DeclarationOrder", [1]);
  initializer("ArgumentBeforeInitializer", [0]);
  initializer("ArgumentBeforeInitializer", [1]);

  function compoundPair(left, right) {
    for (
      const method of [
        "Arithmetic",
        "AddAssignment",
        "DivideAssignment",
        "RemainderAssignment",
        "LeftShiftAssignment",
        "RightShiftAssignment",
        "UnsignedShiftAssignment",
        "Bitwise",
        "AssignmentValue",
      ]
    ) {
      syntax(method, [left, right]);
    }
  }
  for (const left of integerBoundaries) {
    for (const right of integerBoundaries) compoundPair(left, right);
  }
  for (let index = 0; index < 64; index++) {
    compoundPair(randomInt(), randomInt());
  }
  for (const left of floatingBoundaries) {
    for (const right of floatingBoundaries) {
      syntax("FloatArithmetic", [left, right]);
      syntax("DoubleArithmetic", [left, right]);
    }
    syntax("MixedArithmetic", [left, randomInt()]);
  }
  for (const value of [0, 1]) {
    syntax("BooleanEager", [value]);
    syntax("NullCompoundOrder", [value]);
    syntax("NullArrayCompoundOrder", [value]);
    syntax("BoundsCompoundOrder", [value]);
    syntax("IndexFaultBeforeNull", [value]);
  }
  for (
    const method of [
      "FieldEvaluationOrder",
      "ArrayEvaluationOrder",
      "NestedAssignment",
      "ForeachControl",
      "ForeachNested",
      "ForeachCollectionOnce",
      "ForeachMutation",
      "ForeachReferences",
      "ForeachJagged",
      "ForeachWidening",
      "ForeachFloatConversion",
      "ForeachBooleans",
      "ForeachNull",
    ]
  ) {
    syntax(method);
  }
  for (const length of [0, 1, 2, 17, 100]) syntax("ForeachSum", [length]);
  for (const wanted of [0, 3, 7, 11, 12]) {
    syntax("ForeachEarlyReturn", [wanted]);
  }
  syntax("ForeachFuel", [], {
    fault: 1,
    reason: "Finite loops can exceed the compiler's control-step fuel budget.",
  });
  syntax("ForeachSum", [3]);

  for (let index = 0; index < 64; index++) {
    heap("ParticleSimulation", [bounded(16), bounded(12)]);
    heap("SharedGraphWeight", [randomInt()]);
  }
  heap("ParticleSimulation", [-1, 0]);
  heap("ParticleSimulation", [1, -1]);
  for (let y = -1; y <= 5; y++) {
    for (let x = -1; x <= 7; x++) heap("MazeDistance", [x, y]);
  }
  for (const count of [0, 1, 2, 10, 127]) heap("AllocationPressure", [count]);
  heap("AllocationPressure", [128], {
    fault: 3,
    reason: "Cumulative allocation charging is independent of CLR collection.",
  });
  heap("AllocationPressure", [1]); // A normal entry must recover after the fault.

  // The wider scalars: every conversion pair over the same boundary values the
  // narrower types use, plus 64-bit and unsigned arithmetic.
  const wideBoundaries = [
    -(2n ** 63n),
    -(2n ** 63n) + 1n,
    -(2n ** 32n),
    -2147483649n,
    -2147483648n,
    -65537n,
    -256n,
    -1n,
    0n,
    1n,
    255n,
    256n,
    65535n,
    65536n,
    2147483647n,
    2147483648n,
    4294967295n,
    4294967296n,
    2n ** 53n + 1n,
    2n ** 63n - 1n,
  ];
  const unsignedBoundaries = integerBoundaries.map((value) => value >>> 0);
  const narrowBoundaries = [
    -32769,
    -32768,
    -32767,
    -129,
    -128,
    -127,
    -1,
    0,
    1,
    127,
    128,
    255,
    256,
    32767,
    32768,
    65535,
    65536,
    65537,
  ];
  for (
    const value of floatingBoundaries.concat([
      -2147483649,
      -2147483648.5,
      2147483647.5,
      2147483648,
      4294967295.5,
      4294967296,
      -9223372036854775809,
      9223372036854775808,
      18446744073709551616,
      -1e30,
      1e30,
      -0.99,
      0.99,
      300.7,
      -300.7,
      65535.9,
      65536.1,
      3e9,
    ])
  ) {
    for (
      const method of [
        "DoubleToInt",
        "DoubleToUInt",
        "DoubleToLong",
        "DoubleToULong",
        "DoubleToByte",
        "DoubleToSByte",
        "DoubleToShort",
        "DoubleToUShort",
        "DoubleToChar",
        "FloatToInt",
        "FloatToUInt",
        "FloatToLong",
        "FloatToULong",
        "FloatToByte",
        "FloatToShort",
        "Floor",
        "Ceiling",
        "Truncate",
        "Round",
        "Sqrt",
        "AbsDouble",
        "AbsFloat",
        "FloorSingle",
        "CeilingSingle",
        "TruncateSingle",
        "RoundSingle",
        "SqrtSingle",
        "IsNaN",
        "IsInfinity",
        "IsFinite",
        "IsNaNSingle",
        "IsFiniteSingle",
        "NaNSwitch",
        "DoubleIncrement",
      ]
    ) {
      numeric(method, [value]);
    }
    for (const right of [-0, 0, -1.5, 2, NaN, Infinity]) {
      for (
        const method of ["MinDouble", "MaxDouble", "MinSingle", "MaxSingle"]
      ) {
        numeric(method, [value, right]);
      }
      // The sign bit of NaN is not specified: .NET's double.NaN is negative,
      // JavaScript's is positive, and only CopySign can tell them apart.
      if (!Number.isNaN(right)) {
        numeric("CopySign", [value, right]);
        numeric("CopySignSingle", [value, right]);
      }
      numeric("ClampDouble", [value, -1, right]);
    }
  }
  for (const value of integerBoundaries.concat(narrowBoundaries)) {
    for (
      const method of [
        "IntToByte",
        "IntToSByte",
        "IntToShort",
        "IntToUShort",
        "IntToChar",
        "IntToLong",
        "IntToULong",
        "AbsInt",
        "TrailingZeros",
        "Classify",
        "Patterns",
        "ByteCompound",
      ]
    ) {
      numeric(
        method,
        method === "ByteCompound" ? [value & 0xff, value] : [value],
      );
    }
    numeric("LevelWeight", [value & 7]);
    numeric("NextLevel", [value]);
    const unsigned = value >>> 0;
    for (
      const method of [
        "UIntToLong",
        "UIntToULong",
        "UIntToFloat",
        "UIntToDouble",
        "PopCount",
        "LeadingZeros",
      ]
    ) {
      numeric(method, [unsigned]);
    }
    for (const count of [0, 1, 31, 32, 33, 63, 64, 65, -1]) {
      numeric("RotateLeft", [unsigned, count]);
      numeric("RotateRight", [unsigned, count]);
      numeric("UIntShiftRight", [unsigned, count]);
    }
    const narrow = value & 0xffff;
    for (
      const method of [
        "UShortToInt",
        "UShortToSByte",
        "UShortToShort",
        "CharToUShort",
        "UShortToChar",
        "CharIncrement",
      ]
    ) {
      numeric(method, [narrow]);
    }
    const signedNarrow = (value << 16) >> 16;
    for (const method of ["ShortToUShort", "ShortToByte", "ShortDecrement"]) {
      numeric(method, [signedNarrow]);
    }
    numeric("SByteToShort", [(value << 24) >> 24]);
    numeric("SByteToDouble", [(value << 24) >> 24]);
    numeric("SByteIncrement", [(value << 24) >> 24]);
    numeric("ByteToFloat", [value & 0xff]);
    numeric("UShortMultiply", [narrow, (value * 7) & 0xffff]);
    numeric("NextKind", [value & 0xff]);
    numeric("PreviousKind", [value & 0xff]);
    numeric("KindMask", [value & 0xff, (value >> 2) & 0xff]);
    numeric("KindCompare", [value & 0xff, (value >> 3) & 0xff]);
    numeric("LevelValue", [value]);
  }
  for (const left of wideBoundaries) {
    for (
      const method of [
        "LongToFloat",
        "LongToDouble",
        "LongToInt",
        "LongToUInt",
        "LongToShort",
        "LongNegate",
        "LongComplement",
        "AbsLong",
        "LongIncrement",
        "TrailingZerosLong",
      ]
    ) {
      numeric(method, [left]);
    }
    const unsignedLeft = BigInt.asUintN(64, left);
    for (
      const method of [
        "ULongToFloat",
        "ULongToDouble",
        "ULongToByte",
        "PopCountLong",
        "LeadingZerosLong",
      ]
    ) {
      numeric(method, [unsignedLeft]);
    }
    for (const count of [0, 1, 31, 32, 33, 63, 64, 65, -1]) {
      numeric("LongShiftLeft", [left, count]);
      numeric("LongShiftRight", [left, count]);
      numeric("LongShiftUnsigned", [left, count]);
      numeric("ULongShiftRight", [unsignedLeft, count]);
      numeric("RotateLeftLong", [unsignedLeft, count]);
    }
    for (const right of wideBoundaries) {
      for (
        const method of [
          "LongAdd",
          "LongSubtract",
          "LongMultiply",
          "LongDivide",
          "LongRemainder",
          "LongAnd",
          "LongOr",
          "LongXor",
          "LongLess",
          "LongGreaterOrEqual",
          "MaxLong",
        ]
      ) {
        numeric(method, [left, right]);
      }
      const unsignedRight = BigInt.asUintN(64, right);
      for (
        const method of [
          "ULongDivide",
          "ULongRemainder",
          "ULongLess",
          "MinULong",
        ]
      ) {
        numeric(method, [unsignedLeft, unsignedRight]);
      }
    }
  }
  for (const left of unsignedBoundaries) {
    for (const right of unsignedBoundaries) {
      for (
        const method of [
          "UIntDivide",
          "UIntRemainder",
          "UIntMultiply",
          "UIntLess",
          "UIntGreater",
          "MinUInt",
        ]
      ) {
        numeric(method, [left, right]);
      }
      numeric("ClampUInt", [left, right, right + 5 >>> 0]);
    }
  }
  for (const left of integerBoundaries) {
    for (const right of integerBoundaries) {
      numeric("MinInt", [left, right]);
      numeric("MaxInt", [left, right]);
      numeric("ClampInt", [
        left,
        right,
        right + 1 === 2147483648 ? right : right + 1,
      ]);
      numeric("ClampInt", [left, right, left]);
    }
  }
  // tests/Features.cs, the behavior suite's feature tour, on the CLR's terms.
  // Static state is per type on both sides, so the stateful calls line up.
  for (const input of [-5, 0, 1, 2, 3, 4, 50, 101, 150, 199, 200, 250]) {
    feature("Switches", "Classify", [input]);
  }
  for (const input of [0, 1, 2, 3, 6, 10]) {
    feature("Switches", "SwitchBreak", [input]);
  }
  for (const input of [0, 1, 2, 3, 4]) {
    feature("Switches", "SharedDefault", [input]);
  }
  for (const input of [0, 1, 2, 3, 4, 7]) {
    feature("Switches", "DefaultDeclares", [input]);
  }
  for (const input of [0, 1, 2, 3, 255]) {
    feature("Switches", "KindScore", [input]);
    feature("Flags", "NextKind", [input]);
    feature("Flags", "Underlying", [input]);
  }
  for (const input of [-1, 0, 1, 2, 3, 4, 5]) {
    feature("Switches", "LevelWeight", [input]);
  }
  for (const input of [4, 5, 6, 7, 10, 11, 19, 20]) {
    feature("Switches", "IsPattern", [input]);
  }
  for (const input of [0, 1]) {
    feature("Switches", "NotNull", [input]);
    feature("Properties", "Coalesce", [input]);
  }
  for (const input of [0, 1, 2, 4]) feature("Switches", "DoWhile", [input]);
  for (const input of [NaN, -0, 0, 1, -Infinity]) {
    feature("Switches", "NaNCase", [input]);
  }
  for (
    const [state, button] of [
      [0, 1],
      [9, 8],
      [9, 0],
      [31, 2],
      [4294967295, 16],
    ]
  ) {
    for (const method of ["Press", "Held", "Toggle", "Release"]) {
      feature("Flags", method, [state, button]);
    }
  }
  for (const method of ["Basic", "Discard", "NullProperty"]) {
    feature("Properties", method);
  }
  for (const input of [-5, 0, 7]) feature("Properties", "Backed", [input]);
  feature("StaticConstructorOrder", "Get");
  feature("StaticConstructorOrder", "Log");
  feature("InitOrder", "Sum");
  for (let index = 0; index < 3; index++) feature("Counter", "Next");
  feature("Counter", "CallCount");
  feature("Exposed", "Visible");
  for (
    const [left, right] of [
      [3n, 4n],
      [-8n, 4n],
      [2n ** 63n - 1n, -1n],
    ]
  ) {
    feature("Numbers", "Wide", [left, right]);
  }
  for (
    const [left, right] of [
      [2n ** 64n - 1n, 10],
      [7n, 0],
      [2n ** 63n, 4294967295],
    ]
  ) {
    feature("Numbers", "Unsigned", [left, right]);
  }
  for (
    const [left, right] of [
      [4294967295, 2],
      [1, 0],
      [5, 4294967295],
    ]
  ) {
    feature("Numbers", "UnsignedDivide", [left, right]);
    feature("Numbers", "UnsignedLess", [left, right]);
  }
  for (const value of [1e10, -1e10, NaN, -2.9, 2.5, -3.5, 2.25, -0]) {
    feature("Numbers", "Saturate", [value]);
    feature("Numbers", "Round", [value]);
    feature("Numbers", "IsNaN", [value]);
  }
  for (const value of [-5, 4e9, 5e9, 1.5, Infinity, NaN]) {
    feature("Numbers", "SaturateUnsigned", [value]);
    feature("Numbers", "Sqrt", [value]);
    feature("Numbers", "IsFinite", [value]);
  }
  for (const value of [300, -1, 200, -2147483648, 2147483647]) {
    feature("Numbers", "ToByte", [value]);
    feature("Numbers", "ToSByte", [value]);
    feature("Numbers", "Extend", [value]);
    feature("Numbers", "Absolute", [value]);
    feature("Numbers", "ExtendUnsigned", [value >>> 0]);
    feature("Numbers", "PopCount", [value >>> 0]);
    feature("Numbers", "Rotate", [value >>> 0, 1]);
  }
  for (const value of [70000n, -1n, 2n ** 40n + 5n]) {
    feature("Numbers", "Shorten", [value]);
  }
  for (const value of [0, 65, 65535]) {
    feature("Numbers", "NextChar", [value]);
    feature("Numbers", "CharCode", [value]);
  }
  for (const value of [0, 10, 255]) feature("Numbers", "ByteWrap", [value]);
  for (const count of [0, 40, 65, -1]) {
    feature("Numbers", "ShiftWide", [1n, count]);
  }
  feature("Numbers", "Mixed", [0.5, 2n]);
  for (const value of [0n, 2n ** 64n - 1n, 2n ** 53n + 1n]) {
    feature("Numbers", "FromUnsignedLong", [value]);
  }
  for (
    const [value, minimum, maximum] of [
      [15, 0, 10],
      [-3, 0, 10],
      [1, 5, 0],
    ]
  ) {
    feature("Numbers", "Clamp", [value, minimum, maximum]);
  }
  for (
    const [left, right] of [
      [-0, 0],
      [NaN, 1],
      [1, 2],
    ]
  ) {
    feature("Numbers", "Max", [left, right]);
  }

  for (const count of [0, 1, 2, 5]) numeric("DoWhile", [count]);
  for (const step of [1, 2, 3, 4, 5]) numeric("StaticCounter", [step]);
  numeric("ForeachNarrowing");

  const requestsFile = path.join(output, "requests.json");
  fs.writeFileSync(requestsFile, JSON.stringify(cases, null, 2) + "\n");
  console.log(`Differential seed: 0x${seed.toString(16).padStart(8, "0")}`);
  if (keepArtifacts) console.log(`Differential artifacts: ${output}`);
  // The CLR oracle is built separately (tilde//aseipp/cs2wasm:reference); it
  // runs with the runner's own environment, DOTNET_ROOT included.
  const oracle = process.env.GAMEPLAYC_REFERENCE;
  if (!oracle) {
    throw new Error(
      "Set GAMEPLAYC_REFERENCE to the CLR oracle executable: buck2 build tilde//aseipp/cs2wasm:reference",
    );
  }
  const referenceOutput = run(path.resolve(oracle), [requestsFile]);
  fs.writeFileSync(path.join(output, "reference.jsonl"), referenceOutput);
  const reference = referenceOutput
    .trim()
    .split(/\r?\n/)
    .map((line) => JSON.parse(line));
  assert.equal(
    reference.length,
    cases.length,
    "One CLR result for each request",
  );

  function encodeWasmValue(value, referenceValue) {
    if (referenceValue === "void") {
      assert.equal(value, undefined);
      return "void";
    }
    if (referenceValue.startsWith("i64:")) {
      assert.equal(typeof value, "bigint");
      return `i64:${BigInt.asIntN(64, value)}`;
    }
    assert.equal(typeof value, "number");
    if (referenceValue.startsWith("i32:")) return `i32:${value}`;
    if (Number.isNaN(value)) return "f64:NaN";
    const bits = new DataView(new ArrayBuffer(8));
    bits.setFloat64(0, value, false);
    return "f64:" + bits.getBigUint64(0, false).toString(16).padStart(16, "0");
  }

  function expectedFault(test, outcome) {
    switch (outcome.Exception) {
      case "NullReferenceException":
        return 5;
      case "IndexOutOfRangeException":
        return 6;
      case "DivideByZeroException":
        return 7;
      case "OverflowException":
        // A negative or unrepresentable array size; a ulong index past
        // long.MaxValue failing its conversion to a native integer.
        if (
          /^Differential\.Operations\.(U?Long)?ArrayLength$/.test(test.method)
        ) {
          return 4;
        }
        if (
          /^Differential\.Operations\.ULong(Array|Null)Read$/.test(test.method)
        ) {
          return 9;
        }
        return test.method.includes(".Abs") ? 9 : 8;
      case "ArgumentException":
        return 10;
      case "SwitchExpressionException":
        return 11;
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
    const context = `seed=0x${seed.toString(16)} case=${index} ` +
      `${test.method}(${test.args.join(", ")})`;
    try {
      const invoke = exports[test.method];
      assert.equal(typeof invoke, "function", "Export exists");
      let value;
      let trapped = false;
      try {
        value = invoke(...inputs[index]);
      } catch (error) {
        assert.ok(
          error instanceof WebAssembly.RuntimeError,
          "Expected a Wasm trap",
        );
        trapped = true;
      }

      if (test.policy) {
        // Each exception to CLR equivalence is attached to one concrete input.
        // Require actual successful CLR execution and the documented Wasm fault.
        assert.equal(expected.Kind, "value", test.policy.reason);
        assert.equal(trapped, true, test.policy.reason);
        assert.equal(
          exports.__fault.value,
          test.policy.fault,
          test.policy.reason,
        );
        policyChecks++;
      } else if (expected.Kind === "exception") {
        assert.equal(trapped, true, `CLR threw ${expected.Exception}`);
        assert.equal(exports.__fault.value, expectedFault(test, expected));
        equalFaults++;
      } else {
        assert.equal(
          trapped,
          false,
          `CLR returned ${expected.Value}; Wasm fault=${exports.__fault.value}`,
        );
        assert.equal(
          exports.__fault.value,
          0,
          "Success resets the fault state",
        );
        assert.equal(encodeWasmValue(value, expected.Value), expected.Value);
        equalValues++;
      }
    } catch (error) {
      const artifacts = keepArtifacts
        ? `Artifacts: ${output}`
        : "Set GAMEPLAYC_KEEP_ARTIFACTS=1 to keep the artifacts.";
      throw new Error(`${context}\n${error.message}\n${artifacts}`, {
        cause: error,
      });
    }
  }

  console.log(
    `PASS: ${equalValues} CLR/Wasm values, ${equalFaults} matching runtime faults, ` +
      `${policyChecks} explicit runtime-policy checks across ${modules.length} C# modules.`,
  );
} finally {
  if (!keepArtifacts) {
    fs.rmSync(output, { recursive: true, force: true });
  }
}

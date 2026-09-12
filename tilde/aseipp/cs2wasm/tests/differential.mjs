// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

// Compare actual CLR execution with gameplayc output for identical C#.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { reportFailures } from "./failures.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const arguments_ = process.argv.slice(2);
const seedOption = arguments_.find((option) => option.startsWith("--seed="));
// A module that does not compile, and a case that disagrees, is a failure
// of its own; the run goes on and reports them all (tests/failures.mjs).
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
    "Usage: deno run --allow-all tests/differential.mjs <compiler command...> [--seed=0x5eed1234] " +
      "; " +
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

  // The compiler command, such as the JIT layout's `dotnet exec
  // gameplayc.dll`; the reference always uses the installed SDK.
  function compile(args) {
    return run(command[0], [...command.slice(1), ...args], process.env);
  }

  // The gameplay CoreLib's host services (corelib/Host.cs): the clocks and
  // randomness.
  const gameplayHost = {
    "clock-utc": () => BigInt(Date.now()) * 1000n,
    "clock-monotonic": () => process.hrtime.bigint(),
    random: () =>
      BigInt.asIntN(
        64,
        (BigInt(Math.floor(Math.random() * 2 ** 32)) << 32n) |
          BigInt(Math.floor(Math.random() * 2 ** 32)),
      ),
  };

  // The features module's host import is read only by static initializers
  // of classes these cases never use.
  const modules = [
    { name: "operations", source: "tests/Differential.cs" },
    { name: "constructors", source: "tests/Constructors.cs" },
    { name: "field-initializers", source: "tests/FieldInitializers.cs" },
    { name: "syntax", source: "tests/Syntax.cs" },
    { name: "heap", source: "examples/HeapGameplay.cs" },
    { name: "inheritance", source: "tests/Inheritance.cs" },
    { name: "interfaces", source: "tests/Interfaces.cs" },
    { name: "delegates", source: "tests/Delegates.cs" },
    { name: "generics", source: "tests/Generics.cs" },
    { name: "structs", source: "tests/Structs.cs" },
    { name: "construction", source: "tests/Construction.cs" },
    { name: "collections", source: "tests/Collections.cs" },
    { name: "exceptions", source: "tests/Exceptions.cs" },
    { name: "filters", source: "tests/Filters.cs" },
    { name: "messages", source: "tests/ExceptionMessages.cs" },
    { name: "unions", source: "tests/Unions.cs" },
    { name: "records", source: "tests/Records.cs" },
    { name: "boxing", source: "tests/Boxing.cs" },
    { name: "formatting", source: "tests/Formatting.cs" },
    { name: "transcendentals", source: "tests/Transcendentals.cs" },
    { name: "tuples", source: "tests/Tuples.cs" },
    { name: "nullables", source: "tests/Nullables.cs" },
    { name: "parameters", source: "tests/Parameters.cs" },
    { name: "statements", source: "tests/Statements.cs" },
    { name: "characters", source: "tests/Characters.cs" },
    { name: "text", source: "tests/Text.cs" },
    { name: "multicast", source: "tests/Multicast.cs" },
    { name: "primary-constructors", source: "tests/PrimaryConstructors.cs" },
    { name: "sorting", source: "tests/Sorting.cs" },
    { name: "jumps", source: "tests/Jumps.cs" },
    { name: "checked", source: "tests/Checked.cs" },
    { name: "ranges", source: "tests/Ranges.cs" },
    { name: "regressions", source: "tests/Regressions.cs" },
    { name: "initializers", source: "tests/Initializers.cs" },
    { name: "numerics", source: "tests/Numerics.cs" },
    { name: "dispatch", source: "tests/Dispatch.cs" },
    { name: "types", source: "tests/Types.cs" },
    { name: "enum-members", source: "tests/EnumMembers.cs" },
    { name: "references", source: "tests/References.cs" },
    { name: "enumerables", source: "tests/Enumerables.cs" },
    { name: "iterators", source: "tests/Iterators.cs" },
    { name: "linq", source: "tests/Linq.cs" },
    { name: "anonymous", source: "tests/Anonymous.cs" },
    { name: "unprinted-records", source: "tests/UnprintedRecords.cs" },
    { name: "many-types", source: "tests/ManyTypes.cs" },
    { name: "converts", source: "tests/Converts.cs" },
    { name: "memories", source: "tests/Memories.cs" },
    { name: "interface-events", source: "tests/InterfaceEvents.cs" },
    { name: "decimals", source: "tests/Decimals.cs" },
    { name: "spans", source: "tests/Spans.cs" },
    { name: "more-collections", source: "tests/MoreCollections.cs" },
    { name: "comparers", source: "tests/Comparers.cs" },
    { name: "multi-arrays", source: "tests/MultiArrays.cs" },
    { name: "type-initialization", source: "tests/TypeInitialization.cs" },
    { name: "combinations", source: "tests/Combinations.cs" },
    { name: "strings", source: "tests/Strings.cs" },
    {
      name: "features",
      source: "tests/Features.cs",
      imports: { features: { read: () => 5 } },
    },
    // The gameplay CoreLib's generic math, framework and task library.
    { name: "generic-math", source: "tests/GenericMath.cs" },
    // Generic math over the native integers, the 128-bit integers and
    // Half, and their text: every Half's shortest digits by Dragon4 take
    // more steps and allocations than the default budgets.
    {
      name: "wide-math",
      source: "tests/WideMath.cs",
      compilerArgs: ["--fuel", "1000000", "--alloc-units", "16777216"],
    },
    {
      name: "il-accepted",
      source: "tests/IlAccepted.cs",
      imports: { gameplay: gameplayHost },
    },
    { name: "il-regressions", source: "tests/IlRegressions.cs" },
    {
      name: "time",
      source: "tests/Time.cs",
      imports: { gameplay: gameplayHost },
    },
    { name: "framework", source: "tests/Framework.cs" },
    { name: "sharing", source: "tests/Sharing.cs" },
    { name: "equatables", source: "tests/Equatables.cs" },
    { name: "async", source: "tests/Async.cs" },
    // Vector128 (Wasm SIMD), and System.Numerics' vectors and
    // matrices on it.
    { name: "simd", source: "tests/Simd.cs" },
    { name: "vectors", source: "tests/Vectors.cs" },
    // System.Runtime.Numerics: dotnet/runtime's BigInteger in the CoreLib.
    // Its multiplications of 1000-bit numbers take more than the default
    // budgets' steps and allocations.
    {
      name: "big-integers",
      source: "tests/BigIntegers.cs",
      compilerArgs: ["--fuel", "1000000", "--alloc-units", "16777216"],
    },
    // Printing double.MaxValue's shortest digits (Dragon4) takes more steps
    // than the default budget.
    {
      name: "complexes",
      source: "tests/Complexes.cs",
      compilerArgs: ["--fuel", "1000000"],
    },
    // The same, its async methods compiled as runtime-async methods, which
    // the compiler splits itself (docs/IMPORTER.md, "Async as built").
    {
      name: "async-runtime",
      source: "tests/Async.cs",
      compilerArgs: ["--runtime-async"],
    },
    // A module over two gameplay libraries (tests/libraries/), one over
    // the other: GAMEPLAYC_LIBRARIES names the directory gameplay.library
    // builds for Shapes (BUILD's :test-shapes), or else they are compiled
    // here.
    {
      name: "libraries",
      source: "tests/Libraries.cs",
      libraries: [
        { name: "Geometry", sources: ["tests/libraries/Geometry.cs"] },
        { name: "Shapes", sources: ["tests/libraries/Shapes.cs"] },
      ],
    },
  ];
  // GAMEPLAYC_DIFFERENTIAL_MODULES=simd,linq runs only the modules named,
  // and their cases (for working on one).
  const only = process.env.GAMEPLAYC_DIFFERENTIAL_MODULES?.split(",");
  if (only) {
    modules.splice(
      0,
      modules.length,
      ...modules.filter((module) => only.includes(module.name)),
    );
  }
  const instances = new Map();
  // What failed (key -> message) and what passed.
  const failures = new Map();
  const passed = new Set();
  for (const module of modules) {
    const wasm = path.join(output, `${module.name}.wasm`);
    // The CLR oracle catches what escapes a call and goes on, as a module
    // recovering after a trap does.
    try {
      const references = [];
      if (module.libraries && process.env.GAMEPLAYC_LIBRARIES) {
        references.push("--reference", process.env.GAMEPLAYC_LIBRARIES);
      } else {
        // Each library over those before it.
        for (const library of module.libraries ?? []) {
          const assembly = path.join(
            output,
            module.name,
            `${library.name}.dll`,
          );
          compile([
            "--library",
            library.name,
            ...references,
            "-o",
            assembly,
            ...library.sources.map((source) => path.join(root, source)),
          ]);
          references.push("--reference", assembly);
        }
      }
      compile([
        ...(module.compilerArgs ?? []),
        ...references,
        "--recover-after-trap",
        "-o",
        wasm,
        path.join(root, module.source),
      ]);
    } catch (error) {
      failures.set(
        `module:${module.name}`,
        // The compiler's first line of output, after the command line.
        String(error.message).split("\n").slice(1).find((line) =>
          line.trim()
        ) ??
          String(error.message).split("\n")[0],
      );
      continue;
    }

    const bytes = fs.readFileSync(wasm);
    try {
      instances.set(
        module.name,
        new WebAssembly.Instance(
          new WebAssembly.Module(bytes),
          module.imports,
        ).exports,
      );
      passed.add(`module:${module.name}`);
    } catch (error) {
      failures.set(
        `module:${module.name}`,
        `invalid Wasm: ${String(error.message).split("\n")[0]}`,
      );
    }
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
  const inheritance = (method, args = []) =>
    add("inheritance", "Tests.Inheritance", method, args);
  const interfaces = (method, args = []) =>
    add("interfaces", "Tests.Interfaces", method, args);
  const delegates = (method, args = []) =>
    add("delegates", "Tests.Delegates", method, args);
  const generics = (method, args = []) =>
    add("generics", "Tests.GenericTypes.Generics", method, args);
  const structs = (method, args = []) =>
    add("structs", "Tests.StructTypes.Structs", method, args);
  const collections = (method, args = []) =>
    add("collections", "Tests.CollectionTypes.Collections", method, args);
  const exceptions = (method, args = []) =>
    add("exceptions", "Tests.ExceptionTypes.Exceptions", method, args);

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

  // tests/Inheritance.cs: dispatch, construction order, casts and patterns.
  for (
    const method of [
      "Areas",
      "ConstructorOrder",
      "ImplicitConstructorOrder",
      "Hiding",
      "NullDowncast",
      "NullReceiver",
      "ObjectInitializer",
      "ExplicitObjectBaseConstructor",
    ]
  ) {
    inheritance(method);
  }
  for (const kind of [0, 1, 2, 3, 9]) {
    for (
      const method of [
        "Describe",
        "BaseFields",
        "Downcast",
        "As",
        "IsType",
        "IsPattern",
        "SwitchExpression",
        "SwitchStatement",
      ]
    ) {
      inheritance(method, [kind]);
    }
  }
  for (const value of [-1, 0, 5, 2147483647]) {
    inheritance("VirtualProperty", [value]);
  }
  for (const length of [0, 1, 4, 20]) inheritance("Recursion", [length]);

  // tests/Interfaces.cs: itable dispatch, interface casts and tests.
  for (
    const method of [
      "Entities",
      "BaseInterface",
      "Field",
      "Identity",
      "ClassReceiver",
    ]
  ) {
    interfaces(method);
  }
  for (const kind of [0, 1, 2, 3]) {
    for (
      const method of ["Is", "As", "CastToInterface", "CastToClass", "Switch"]
    ) {
      interfaces(method, [kind]);
    }
    for (const value of [-3, 0, 5]) interfaces("Score", [kind, value]);
  }
  for (const value of [-2147483648, -1, 0, 7]) interfaces("Parameter", [value]);
  for (const kind of [0, 1]) interfaces("Unimplemented", [kind]);

  // tests/Delegates.cs: method groups, lambdas and invocation, including a
  // null delegate and null method-group targets.
  for (const value of [-5, 0, 4, 100]) delegates("Lambdas", [value]);
  for (const value of [-5, 0, 4, 2147483647]) {
    for (
      const method of [
        "StaticMethodGroup",
        "InstanceMethodGroup",
        "StructMethodGroup",
        "VirtualMethodGroup",
        "InterfaceMethodGroup",
        "Fields",
        "Arrays",
        "HigherOrder",
      ]
    ) {
      delegates(method, [value]);
    }
  }
  for (const which of [0, 1]) {
    for (
      const method of [
        "NullInvoke",
        "NullInstanceTarget",
        "NullVirtualTarget",
        "ConditionalInvoke",
        "NullChecks",
      ]
    ) {
      delegates(method, [which]);
    }
  }
  for (const count of [0, 1, 4, 20]) delegates("Folding", [count]);
  // Captured variables: shared with the declaring method, fresh per
  // iteration for foreach variables and loop-body locals, shared for a for
  // loop's variable.
  for (
    const method of [
      "AnonymousMethodCapture",
      "LoopCaptureFor",
      "LoopCaptureForeach",
      "LoopCaptureBodyLocal",
      "CaptureThis",
    ]
  ) {
    delegates(method);
  }
  for (const value of [-2147483648, -1, 0, 5, 20, 2147483647]) {
    for (
      const method of [
        "ClosureMutation",
        "ParameterCapture",
        "NestedClosures",
        "PatternCapture",
        "SwitchCapture",
        "LocalFunctionDelegates",
        "ConstructorCapture",
        "LocalFunctionThis",
        "ArmCapture",
      ]
    ) {
      delegates(method, [value]);
    }
  }
  for (const n of [0, 1, 5, 10]) delegates("LocalFunctions", [n]);
  for (let which = 0; which < 24; which++) {
    delegates("ObjectMethodGroups", [which]);
  }

  // tests/Generics.cs: every instantiation its own code and static state.
  // The per-instantiation counters run in the same order on both sides.
  for (const value of [-3, 0, 1, 4, 100]) {
    for (
      const method of [
        "Boxes",
        "NestedBoxes",
        "Pairs",
        "GenericMethods",
        "Stores",
        "Constraints",
        "Defaults",
        "Delegates",
        "Closures",
        "LocalFunctions",
      ]
    ) {
      generics(method, [value]);
    }
  }
  for (const count of [0, 1, 3, 7]) {
    for (const method of ["Chains", "Arrays", "Nodes"]) {
      generics(method, [count]);
    }
  }
  for (const kind of [0, 1, 2]) generics("Casts", [kind]);
  generics("BadCast");
  generics("DualInterfaces");
  for (const step of [1, 2, 3]) generics("StaticsPerInstantiation", [step]);

  // tests/Structs.cs: copies on assignment, arguments and elements;
  // mutation through `this`, `ref` and `out`, in boxes and in place.
  for (const value of [-7, -1, 0, 1, 3, 9, 2147483647]) {
    for (
      const method of [
        "CopySemantics",
        "Properties",
        "WholeThis",
        "ArrayInitializer",
        "Fields",
        "AutoProperty",
        "Nested",
        "Constructors",
        "MixedFields",
        "Closures",
        "Statics",
        "References",
        "Generic",
        "Conditional",
        "Temporaries",
        "Dispatch",
        "Throws",
      ]
    ) {
      structs(method, [value]);
    }
  }
  for (const value of [-2.5, 0, 3, NaN, Infinity]) {
    structs("Vectors", [value]);
    structs("Operators", [value]);
  }
  for (const count of [1, 2, 7]) structs("Arrays", [count]);
  for (const value of [0, 3, 9, 20]) structs("RefParameters", [value]);
  // The CLR takes a nested field's or element's address, checking the
  // receiver or index, before the right-hand side runs; Calls counts runs.
  for (
    const [method, args] of [
      ["NullNestedStore", []],
      ["Calls", []],
      ["NullStore", []],
      ["Calls", []],
      ["OutOfRangeStore", [5]],
      ["Calls", []],
      ["OutOfRangeStore", [-1]],
      ["Calls", []],
      ["OutOfRangeStore", [1]],
      ["Calls", []],
    ]
  ) {
    structs(method, args);
  }

  // tests/Construction.cs: structs made in place and through their
  // constructors.
  for (const value of [-3, 0, 1, 7, 40]) {
    for (
      const method of [
        "Fields",
        "ConstantFields",
        "Factory",
        "Records",
        "Generic",
        "NestedValues",
        "Tuples",
        "Numerics",
        "ComputedValue",
        "StaticConstructor",
      ]
    ) {
      add("construction", "Tests.Construction.Construction", method, [value]);
    }
  }
  for (const count of [0, 10, 1000]) {
    for (
      const method of [
        "ManyVectors",
        "ManyStructs",
        "ManyInArguments",
        "ManySines",
      ]
    ) {
      add("construction", "Tests.Construction.Construction", method, [count]);
    }
  }

  // tests/Collections.cs: the runtime's List, Dictionary, HashSet, Queue
  // and Stack against the BCL's. Enumeration order after seeded runs of
  // adds and removes, growth, faults, and modification while enumerating.
  for (let run = 0; run < 24; run++) {
    const seed = randomInt();
    collections("DictionaryOrder", [seed]);
    collections("HashSetOrder", [seed]);
  }
  for (const count of [0, 1, 7]) {
    collections("EnumeratorsDisposed", [count]);
  }
  for (const count of [0, 1, 2, 3, 4, 5, 9, 17, 40]) {
    for (
      const method of [
        "ListForeach",
        "ListGrowth",
        "ListOfReferences",
        "Queues",
        "Stacks",
        "Nested",
      ]
    ) {
      collections(method, [count]);
    }
  }
  for (const count of [1, 2, 3, 4, 5, 9, 17, 40]) {
    for (
      const method of [
        "ListBasics",
        "ListOfStructs",
        "ReferenceKeys",
        "InterfaceKeys",
        "StructKeys",
      ]
    ) {
      collections(method, [count]);
    }
  }
  for (const mode of [0, 1, 2, 3, 4, 5, 6]) {
    for (
      const method of [
        "ListModifiedWhileEnumerating",
        "ListFaults",
        "FloatEquality",
        "DictionaryFaults",
        "DictionaryModifiedWhileEnumerating",
        "KeysModifiedWhileEnumerating",
        "HashSetModifiedWhileEnumerating",
        "NullElements",
        "EmptyFaults",
        "QueueModifiedWhileEnumerating",
      ]
    ) {
      collections(method, [mode]);
    }
  }
  for (const threshold of [-1, 0, 3, 5, 9, 20]) {
    collections("ListPredicates", [threshold]);
    collections("DictionaryBasics", [threshold]);
  }
  collections("ListForEachModified");

  // tests/Exceptions.cs: catch clauses and filters, the order of finally
  // blocks on every exit, rethrows, exceptions across calls, the exceptions
  // compiler checks throw, and what escapes an entry.
  for (let kind = 0; kind < 14; kind++) {
    for (
      const method of [
        "CatchTypes",
        "FinallyOrder",
        "FinallyReplacesException",
        "Rethrow",
        "Checks",
        "Hierarchy",
        "Escapes",
        "Generic",
        "CatchAll",
      ]
    ) {
      exceptions(method, [kind]);
    }
  }
  // tests/Filters.cs: two-pass exception handling. Filters run before the
  // finally blocks between the throw and the clause chosen, at every depth,
  // through virtual calls, delegates and closures, when they throw, and
  // when nothing takes the exception (LastLog, right after, shows the order).
  const filters = (method, args = []) =>
    add("filters", "Tests.Filters.Filters", method, args);
  for (let value = -3; value < 7; value++) {
    for (
      const method of [
        "BeforeFinally",
        "Levels",
        "SeesStateBeforeFinally",
        "ThrowingFilters",
        "AcrossCalls",
        "Rethrows",
        "Variables",
        "Leaving",
        "FinallyThrowsInside",
        "Checks",
        "Generic",
        "InitializerBoundary",
      ]
    ) {
      filters(method, [value]);
    }
    for (const wanted of [value, value + 30]) {
      filters("DeepRecords", [wanted]);
    }
    filters("Escapes", [value]);
    filters("LastLog");
  }
  filters("Escapes", [100]);
  filters("LastLog");
  filters("Escapes", [200]);
  filters("LastLog");

  // tests/ExceptionMessages.cs: messages and inner exceptions the program
  // supplies, the BCL's classes' own, argument exceptions' parameter names,
  // and a TypeInitializationException's type name and inner exception.
  const messages = (method, args = []) =>
    add("messages", "Tests.ExceptionMessages.Messages", method, args);
  for (const value of [-2147483648, -5, 0, 1, 42]) {
    messages("UserMessage", [value]);
    messages("Inner", [value]);
    messages("Wrapped", [value]);
  }
  for (let which = 0; which < 5; which++) messages("FrameworkMessage", [which]);
  messages("NullMessageKeepsDefault");
  messages("NullReceiver");
  for (let which = 0; which < 26; which++) messages("OwnDefault", [which]);
  for (let which = 0; which < 15; which++) messages("ParamNames", [which]);
  for (const which of [-3, 0, 4]) messages("Thrown", [which]);
  for (let which = 0; which < 5; which++) messages("CheckMessage", [which]);
  for (let which = 0; which < 9; which++) messages("ThrownText", [which]);
  messages("TypeInitialization");
  messages("TypeInitialization");

  // tests/Unions.cs: C# 15 unions and closed classes: conversions of case
  // values, switches and patterns over them, the default union, unions as
  // elements and fields, generic unions.
  const unions = (method, args = []) =>
    add("unions", "Tests.Unions.Unions", method, args);
  for (let value = -2; value < 7; value++) {
    for (
      const method of [
        "Switches",
        "Patterns",
        "Statements",
        "Storage",
        "Payloads",
        "Generic",
        "Closed",
        "Properties",
      ]
    ) {
      unions(method, [value]);
    }
  }
  unions("Unmatched");

  // tests/Records.cs: records and record structs: value equality across
  // inheritance, `with`, copy constructors, ToString, deconstruction,
  // positional and property patterns, records as keys, user-declared
  // members, primary constructors of classes and structs.
  const records = (method, args = []) =>
    add("records", "Tests.Records.Records", method, args);
  for (const value of [-2147483648, -7, 0, 1, 3, 4, 6, 12, 2147483647]) {
    for (
      const method of [
        "Equality",
        "Inheritance",
        "With",
        "WithNull",
        "Copies",
        "Deconstruction",
        "DeconstructNull",
        "Patterns",
        "Keys",
        "UserMembers",
        "Structs",
        "Initializers",
        "Generic",
        "Interfaces",
        "FloatEquality",
        "ArrayMembers",
        "Owners",
      ]
    ) {
      records(method, [value]);
    }
  }
  for (let which = 0; which < 18; which++) records("Printing", [which]);
  for (let which = 0; which < 6; which++) {
    records("SourcePrintMembers", [which]);
  }

  // tests/Boxing.cs: boxes of scalars, enums, structs and record structs,
  // unboxing, type tests and patterns on objects, interface calls on boxed
  // structs, object equality, hashing and printing, objects as keys, and
  // unions with value-type, union and interface cases.
  const boxing = (method, args = [], policy = null) =>
    add("boxing", "Tests.Boxing.Boxing", method, args, policy);
  for (let which = 0; which < 16; which++) {
    for (
      const method of [
        "Unboxing",
        "Patterns",
        "TypeTests",
        "Casts",
        "Equality",
        "Printing",
      ]
    ) {
      boxing(method, [which]);
    }
  }
  for (let which = 0; which < 10; which++) {
    for (
      const method of [
        "EnumUnboxing",
        "Unions",
        "UnionValues",
        "NestedUnions",
        "InterfaceUnions",
        "Arrays",
      ]
    ) {
      boxing(method, [which]);
    }
  }
  for (const value of [-2147483648, -3, 0, 1, 4, 2147483647]) {
    for (
      const method of [
        "Identity",
        "Copies",
        "Interfaces",
        "Overrides",
        "Keys",
        "UnionEquality",
        "Generic",
      ]
    ) {
      boxing(method, [value]);
    }
  }
  boxing("UnboxNull");
  boxing("BoxMany", [1000]);
  boxing("BoxMany", [200000], {
    fault: 3,
    reason: "Cumulative allocation charging is independent of CLR collection.",
  });
  boxing("ArrayHash");
  boxing("ArrayText");
  boxing("EnumText");
  boxing("DoubleText");
  boxing("DelegateEquality");

  // tests/Formatting.cs: numbers as text: the shortest round-tripping
  // digits of random and boundary doubles and floats, standard and custom
  // format strings, integers in every format, interpolation alignments and
  // formats, and bad format strings.
  const formatting = (method, args = [], policy = null) =>
    add("formatting", "Tests.Formatting.Formatting", method, args, policy);
  for (let item = 0; item < 12; item++) {
    for (let index = 0; index < 60; index++) {
      formatting("Probe", [8, item, index]);
    }
  }
  for (let seed = 0; seed < 300; seed++) formatting("HexFloats", [seed]);
  for (let seed = 0; seed < 1500; seed++) {
    formatting("Doubles", [seed]);
    formatting("Singles", [seed]);
    formatting("Integers", [seed]);
  }
  for (let which = 0; which < 54 * 30; which++) {
    formatting("Special", [which]);
    formatting("SingleSpecial", [which]);
  }
  for (let which = 0; which < 16; which++) {
    for (let index = 0; index < 32; index++) {
      formatting("Character", [which, index]);
    }
  }
  for (
    const value of [
      -2147483648,
      -1000,
      -7,
      0,
      1,
      7,
      22,
      1000,
      123456,
      2147483647,
    ]
  ) {
    formatting("Interpolation", [value]);
    formatting("Concatenation", [value]);
  }
  for (let which = 0; which < 3; which++) formatting("BadFormat", [which]);
  for (let which = 0; which < 20; which++) formatting("Enums", [which]);
  // A thrown exception's text is the CLR's but for its stack trace, which
  // the module does not keep: Messages.ThrownText compares them without it
  // (tests/formatting.mjs checks Formatting.ThrownText's length).
  for (let which = 0; which < 12; which++) formatting("Names", [which]);
  for (
    const value of [
      -2147483648,
      -129,
      -1,
      0,
      1,
      97,
      200,
      40000,
      70000,
      2147483647,
    ]
  ) {
    formatting("Hashes", [value]);
  }

  // tests/Transcendentals.cs: System.Math and MathF over special values,
  // boundaries and random arguments, within an ulp of the CLR's libm, and
  // the exact operations (%, Round, Sign, ScaleB) exactly.
  const transcendental = (method, args, policy = { ulps: 1 }) =>
    add(
      "transcendentals",
      "Tests.Transcendentals.Transcendentals",
      method,
      args,
      policy,
    );
  const exact = (method, args) =>
    add(
      "transcendentals",
      "Tests.Transcendentals.Transcendentals",
      method,
      args,
    );
  const specials = [
    0,
    -0,
    1,
    -1,
    0.5,
    -0.5,
    2,
    3,
    10,
    100,
    0.1,
    1e-10,
    -1e-10,
    1e-300,
    5e-324,
    2.2250738585072014e-308,
    Math.PI,
    Math.PI / 2,
    -Math.PI / 2,
    Math.PI / 4,
    3 * Math.PI / 4,
    Math.E,
    1e10,
    1e22,
    1e300,
    -1e300,
    1.7976931348623157e308,
    700,
    709.78,
    710,
    -700,
    -745,
    -746,
    22,
    -22,
    1e6,
    1647099.3291652855,
    1e7,
    355,
    104348,
    0.7853981633974483,
    0.9999999999999999,
    1.0000000000000002,
    Infinity,
    -Infinity,
    NaN,
  ];
  let mathState = seed ^ 0x12345;
  function randomDouble(kind) {
    mathState = (Math.imul(mathState, 1103515245) + 12345) | 0;
    const u = (mathState >>> 0) / 4294967296;
    mathState = (Math.imul(mathState, 1103515245) + 12345) | 0;
    const v = (mathState >>> 0) / 4294967296;
    switch (kind % 5) {
      case 0:
        return (u - 0.5) * 20;
      case 1:
        return (u - 0.5) * 2 * Math.pow(10, Math.floor(v * 12));
      case 2:
        return u * Math.pow(10, Math.floor(v * 600) - 300);
      case 3:
        return (u - 0.5) * 2;
      default:
        return (u - 0.5) * 1400;
    }
  }
  const unary = [
    "Sin",
    "Cos",
    "Tan",
    "Asin",
    "Acos",
    "Atan",
    "Sinh",
    "Cosh",
    "Tanh",
    "Exp",
    "Log",
    "Log10",
    "Log2",
    "Cbrt",
  ];
  for (const method of unary) {
    // The CLR's functions are glibc's, whose cbrt, sinh, cosh and tanh
    // come out two ulps from the correctly rounded result (Cbrt(1e-10),
    // Sinh(-0.8285472998395562), Tanh(0.5231448872946203)).
    const tolerance = {
      ulps: ["Cbrt", "Sinh", "Cosh", "Tanh"].includes(method) ? 2 : 1,
    };
    for (const x of specials) transcendental(method, [x], tolerance);
    for (let i = 0; i < 400; i++) {
      transcendental(method, [randomDouble(i)], tolerance);
    }
  }
  for (const method of ["SinF", "CosF", "ExpF", "LogF"]) {
    for (const x of specials) {
      transcendental(method, [Math.fround(x)], { ulps: 1, single: true });
    }
    for (let i = 0; i < 200; i++) {
      transcendental(method, [Math.fround(randomDouble(i))], {
        ulps: 1,
        single: true,
      });
    }
  }
  const pairs = [];
  for (
    const x of [
      0,
      -0,
      1,
      -1,
      2,
      -2,
      0.5,
      -0.5,
      10,
      Infinity,
      -Infinity,
      NaN,
      1e300,
      1e-300,
    ]
  ) {
    for (
      const y of [
        0,
        -0,
        1,
        -1,
        2,
        -2,
        3,
        -3,
        0.5,
        2.5,
        Infinity,
        -Infinity,
        NaN,
        1e10,
        -1e10,
      ]
    ) {
      pairs.push([x, y]);
    }
  }
  for (let i = 0; i < 300; i++) {
    pairs.push([randomDouble(i + 1), randomDouble(i + 2)]);
  }
  for (let i = 0; i < 200; i++) {
    pairs.push([Math.abs(randomDouble(3)), randomDouble(0) * 20]);
  }
  for (const [x, y] of pairs) {
    transcendental("Pow", [x, y]);
    transcendental("Atan2", [x, y]);
    transcendental("LogBase", [x, y]);
    transcendental("PowF", [Math.fround(x), Math.fround(y)], {
      ulps: 1,
      single: true,
    });
    transcendental("Atan2F", [Math.fround(x), Math.fround(y)], {
      ulps: 1,
      single: true,
    });
    exact("Remainder", [x, y]);
    exact("CompoundRemainder", [x, y]);
    exact("RemainderF", [Math.fround(x), Math.fround(y)]);
  }
  // Rounding to digits rounds the exact value, so a scaled midpoint that
  // isn't one (2.675 is 2.67499...) goes down.
  const roundings = [
    0.5,
    1.5,
    2.5,
    -2.5,
    1.005,
    2.675,
    655.925,
    123.456789,
    -0.125,
    1e17,
    0.1 + 0.2,
    1e-5,
    1234.5678,
    -98765.4321,
    4503599627370495.5,
    1e-300,
    5e-324,
    0.1,
    1 / 3,
    8388607.5,
    0.000123456789,
    1e15 + 0.3,
  ];
  for (const x of roundings) {
    for (const digits of [0, 1, 2, 3, 4, 7, 11, 15, 17, 20, 23, 30, 320]) {
      for (let mode = 0; mode < 5; mode++) {
        exact("Round", [x, digits, mode]);
        exact("RoundF", [Math.fround(x), digits, mode]);
      }
    }
  }
  for (let i = 0; i < 300; i++) {
    const x = randomDouble(i);
    const digits = i % 18;
    exact("Round", [x, digits, i % 5]);
    exact("RoundF", [Math.fround(x), digits % 12, i % 5]);
  }
  exact("Round", [1.5, -1, 0]);
  exact("Round", [1.5, 1, 9]);
  exact("RoundF", [1.5, 1, -1]);
  for (const x of specials) exact("Sign", [x]);
  for (const x of [1, -1.5, 3e-320, 1e300]) {
    for (const n of [-1100, -1074, -60, 0, 60, 1023, 1100]) {
      exact("ScaleB", [x, n]);
    }
  }
  for (let k = 0; k < 40; k++) exact("Identities", [k]);
  exact("NameOf", []);

  // tests/Tuples.cs: ValueTuple literals, deconstruction, comparison,
  // conversion, text and hashing consistency.
  const tuples = (method, args = []) =>
    add("tuples", "Tests.Tuples.Tuples", method, args);
  for (const a of [-3, 0, 1, 2, 7, 40, 65535, -65536]) {
    for (
      const method of [
        "Deconstruct",
        "MixedText",
        "NullText",
        "NestedText",
        "Keyed",
        "Boxed",
        "BoxedText",
        "Listed",
        "ArrayLoop",
        "Mixed",
        "Nested",
        "Fields",
        "NullCompare",
        "Order",
        "Converted",
        "Generic",
        "Seven",
        "Capture",
      ]
    ) {
      tuples(method, [a]);
    }
    for (const b of [-3, 1, 2, 65535]) {
      tuples("Equal", [a, b]);
      tuples("NotEqual", [a, BigInt(b)]);
      tuples("Swap", [a, b]);
      tuples("Rotate", [a, b, a - b]);
      tuples("Text", [a, b]);
      tuples("Hashes", [a, b]);
    }
  }
  for (
    const value of [
      0n,
      1n,
      65535n,
      65536n,
      1234567890123n,
      -1n,
      -9223372036854775808n,
    ]
  ) {
    tuples("Named", [value]);
  }
  for (const a of [0, -0, 1, NaN, Infinity, 1e-310]) {
    for (const b of [0, -0, 1, NaN, Infinity]) {
      tuples("FloatEqual", [a, b]);
      tuples("FloatEquals", [a, b]);
    }
  }

  // tests/Nullables.cs: nullable value types, their members, conversions,
  // lifted operators, boxing, patterns, ?? and ?.
  const nullables = (method, args = []) =>
    add("nullables", "Tests.Nullables.Nullables", method, args);
  for (
    const a of [
      -7,
      -3,
      -1,
      0,
      1,
      2,
      3,
      4,
      5,
      6,
      7,
      8,
      12,
      51,
      52,
      255,
      256,
      65536,
      2147483647,
    ]
  ) {
    for (
      const method of [
        "Members",
        "Value",
        "Explicit",
        "Coalesce",
        "CoalesceWide",
        "Increments",
        "Conversions",
        "Boxing",
        "Patterns",
        "Switch",
        "Text",
        "Structs",
        "Enums",
        "Access",
        "Fields",
        "Collections",
        "Generic",
        "Capture",
        "Tuple",
        "CoalesceAssign",
      ]
    ) {
      nullables(method, [a]);
    }
    for (const b of [-3, 0, 1, 2, 4, 5, 7]) {
      for (
        const method of [
          "CoalesceChain",
          "Arithmetic",
          "Division",
          "Comparisons",
          "Logic",
          "Compound",
          "Objects",
          "UserOperators",
        ]
      ) {
        nullables(method, [a, b]);
      }
    }
  }
  for (const a of [-1, 0, -0, 1, 2.5, NaN, Infinity]) {
    for (const b of [-1, 0, 1, NaN]) nullables("FloatingCompare", [a, b]);
  }

  // tests/Characters.cs: every code unit's category, classes and cases,
  // and every code point's string casing below U+20000.
  for (let page = 0; page < 256; page++) {
    for (const method of ["Categories", "Classes", "Cases"]) {
      add("characters", "Tests.Characters.Characters", method, [page]);
    }
  }
  for (let start = 0; start < 0x20000; start += 256) {
    add("characters", "Tests.Characters.Characters", "StringCases", [start]);
  }

  // tests/PrimaryConstructors.cs: primary constructor parameters members
  // capture.
  for (const value of [-2, 0, 1, 2, 3, 9]) {
    for (const method of ["Counting", "Inherited", "Generic", "Plain"]) {
      add(
        "primary-constructors",
        "Tests.PrimaryConstructors.PrimaryConstructors",
        method,
        [value],
      );
    }
  }

  // tests/Multicast.cs: combined delegates, delegate equality, hashing
  // consistency and names, events, and array hashes.
  const multicast = (method, args) =>
    add("multicast", "Tests.Multicast.Multicast", method, args);
  for (let which = 0; which < 12; which++) multicast("Combine", [which]);
  for (let which = 0; which < 6; which++) multicast("Names", [which]);
  for (const value of [0, 1, 2, 3, 7, 12]) {
    for (
      const method of [
        "Compound",
        "Results",
        "Equality",
        "Types",
        "Keys",
        "Events",
        "StaticEvents",
        "Emptied",
        "ArrayHashes",
      ]
    ) {
      multicast(method, [value]);
    }
  }

  // tests/Text.cs: string members, StringBuilder, composite formatting and
  // parsing over sample strings (the last sample is null).
  const text = (method, args) => add("text", "Tests.Text.Text", method, args);
  const samples = 39;
  for (let which = 0; which < samples; which++) {
    for (
      const method of [
        "Casing",
        "Trimming",
        "Splitting",
        "ParseDouble",
        "ParseSingle",
        "TryParseDouble",
        "ParseBool",
        "ParseChar",
      ]
    ) {
      text(method, [which]);
    }
    for (let type = 0; type < 8; type++) {
      text("ParseInteger", [which, type]);
      text("TryParseInteger", [which, type % 4]);
    }
    for (const other of [0, 2, 3, 5, 7, 9, 26, 32, 38, which]) {
      text("Searching", [which, other]);
      text("Replacing", [which, other]);
      text("Joining", [which, other]);
    }
    for (const value of [-3, 0, 7, 1000]) {
      text("Formats", [which, value]);
      text("Builder", [which, value]);
    }
  }
  for (let which = 0; which < 11; which++) {
    for (const value of [-7, 0, 42, 65535]) {
      text("RuntimeFormats", [which, value]);
    }
  }
  for (let which = 0; which < 7; which++) text("InvalidFormat", [which]);
  for (let which = 0; which < 5; which++) text("BuilderFaults", [which]);
  for (let which = 0; which < 17; which++) text("ParseDigits", [which]);
  for (
    const unit of [
      0,
      9,
      32,
      48,
      65,
      97,
      160,
      181,
      223,
      255,
      0x130,
      0x131,
      0x2003,
      0x0663,
      0x216B,
      0xD800,
      0xFFFF,
    ]
  ) {
    text("Characters", [unit]);
  }

  // tests/Sorting.cs: Array.Sort and List.Sort in the CLR's introsort
  // order (ties, NaN, -0), searching, the array and list helpers and their
  // faults, and System.Random's seeded sequences.
  const sorting = (method, args = []) =>
    add("sorting", "Tests.Sorting.Sorting", method, args);
  for (const seed of [0, 1, 2, 7, 99, -5]) {
    for (const length of [0, 1, 2, 3, 15, 16, 17, 31, 64, 200, 700]) {
      for (
        const method of ["SortInts", "SortDoubles", "SortStable", "SortOthers"]
      ) {
        sorting(method, [seed, length]);
      }
    }
    for (const length of [1, 4, 10, 33, 100]) {
      for (const method of ["Ranges", "Helpers", "Lists"]) {
        sorting(method, [seed, length]);
      }
    }
  }
  for (let which = 0; which < 7; which++) sorting("Faults", [which]);
  for (
    const seed of [0, 1, 42, 12345, -1, -2147483648, 2147483647, 161803398]
  ) {
    for (let which = 0; which < 10; which++) {
      sorting("Sequence", [seed, which]);
    }
    sorting("RandomCollections", [seed]);
  }
  for (let which = 0; which < 3; which++) sorting("RandomFaults", [which]);
  sorting("Unseeded", [200]);

  // tests/Jumps.cs: goto to labels before and after it, out of loops,
  // try blocks, using statements and switches, goto case and goto default.
  const jumps = (method, args = [], policy = null) =>
    add("jumps", "Tests.Jumps.Jumps", method, args, policy);
  for (const x of [-3, -1, 0, 1, 2, 3, 4, 5, 6, 7, 9, 12, 40]) {
    for (
      const method of [
        "Backward",
        "Forward",
        "NestedExit",
        "InLoop",
        "Edges",
        "Finally",
        "Using",
        "UsingDeclaration",
        "Catch",
        "Lambda",
        "Captured",
        "Case",
        "CaseLoop",
        "CaseStringEntry",
        "CaseEnum",
        "CaseNoDefault",
        "SectionLabels",
      ]
    ) {
      jumps(method, [x]);
    }
  }
  jumps("Fuel", [1000]);
  jumps("Fuel", [500000], {
    fault: 1,
    reason: "A loop made of goto spends the control-step fuel budget.",
  });
  jumps("Fuel", [10]);

  // tests/Checked.cs: checked arithmetic and conversions at and around
  // every boundary.
  const checkedCase = (method, args = []) =>
    add("checked", "Tests.Checked.Checked", method, args);
  const int32s = [
    0,
    1,
    -1,
    2,
    46340,
    46341,
    -46341,
    65535,
    1073741824,
    2147483647,
    -2147483648,
    -2147483647,
  ];
  for (const a of int32s) {
    checkedCase("NegInt", [a]);
    checkedCase("Lambda", [a]);
    checkedCase("EnumConversion", [a]);
    checkedCase("UserDefined", [a, 1, 1]);
    checkedCase("UserDefined", [a, 1, 0]);
    checkedCase("Unchecked", [a]);
    checkedCase("Caught", [a]);
    checkedCase("Enum", [a & 255]);
    checkedCase("NullableStep", [a | 0 & 0xffff]);
    checkedCase("Shift", [a & 255]);
    for (const b of int32s) {
      for (const method of ["AddInt", "SubInt", "MulInt"]) {
        checkedCase(method, [a, b]);
      }
      checkedCase("Mixed", [a, b >>> 0]);
      for (const method of ["AddUInt", "SubUInt", "MulUInt"]) {
        checkedCase(method, [a >>> 0, b >>> 0]);
      }
      checkedCase("Steps", [a % 1000, b % 1000]);
    }
    for (let which = 0; which < 9; which++) checkedCase("Narrow", [which, a]);
    for (let which = 0; which < 8; which++) {
      checkedCase("ConvertSmall", [which, a]);
    }
    for (let which = 0; which < 6; which++) {
      checkedCase("Nullable", [which, a]);
    }
  }
  for (const value of [-129, -128, 127, 128, 255, 256, 32767, 32768, 65536]) {
    checkedCase("Enum", [value & 255]);
    for (let which = 0; which < 9; which++) {
      checkedCase("Narrow", [which, value]);
    }
    for (let which = 0; which < 8; which++) {
      checkedCase("ConvertSmall", [which, value]);
    }
  }
  const int64s = [
    0n,
    1n,
    -1n,
    3037000499n,
    3037000500n,
    -3037000500n,
    4294967295n,
    4294967296n,
    -2147483649n,
    2147483648n,
    9223372036854775807n,
    -9223372036854775808n,
    -9223372036854775807n,
    4611686018427387904n,
  ];
  for (const a of int64s) {
    checkedCase("NegLong", [a]);
    for (const b of int64s) {
      for (const method of ["AddLong", "SubLong", "MulLong"]) {
        checkedCase(method, [a, b]);
      }
      for (const method of ["AddULong", "SubULong", "MulULong"]) {
        checkedCase(method, [BigInt.asUintN(64, a), BigInt.asUintN(64, b)]);
      }
    }
    for (let which = 0; which < 4; which++) checkedCase("Wide", [which, a]);
    for (let which = 0; which < 8; which++) {
      checkedCase("ConvertInt", [which, a]);
    }
    for (let which = 0; which < 5; which++) {
      checkedCase("ConvertUnsigned", [which, BigInt.asUintN(64, a)]);
    }
  }
  for (
    const value of [
      0,
      -0,
      0.5,
      -0.9,
      -1,
      -1.5,
      127.9,
      128,
      255.99,
      256,
      -128.5,
      -129,
      65535.5,
      65536,
      2147483647.9,
      2147483648,
      -2147483648.9,
      -2147483649,
      4294967295.5,
      4294967296,
      9223372036854774784,
      9223372036854775808,
      -9223372036854775808,
      -9223372036854777856,
      18446744073709549568,
      18446744073709551616,
      1e300,
      -1e300,
      Infinity,
      -Infinity,
      NaN,
    ]
  ) {
    for (let which = 0; which < 9; which++) {
      checkedCase("ConvertDouble", [which, value]);
    }
    for (let which = 0; which < 5; which++) {
      checkedCase("ConvertFloat", [which, Math.fround(value)]);
    }
    checkedCase("Floating", [value, 3]);
  }

  // tests/Ranges.cs: indices, ranges, implicit indexers, list, slice and
  // tuple patterns, and the faults out-of-range ones raise.
  const ranges = (method, args = []) =>
    add("ranges", "Tests.Ranges.Ranges", method, args);
  for (const length of [0, 1, 2, 3, 4, 5, 9, 12]) {
    for (let at = 0; at <= length + 1; at++) {
      ranges("FromEnd", [length, at]);
      ranges("Stored", [length, at, 1]);
      ranges("Stored", [length, at, 0]);
      ranges("Assign", [length, at]);
      for (let which = 0; which < 5; which++) {
        ranges("OpenEnds", [length, at, which]);
      }
      for (let end = 0; end <= length + 1; end += 2) {
        ranges("Slice", [length, at, end]);
        ranges("SliceFromEnd", [length, at, end]);
      }
      ranges("Lists", [length, at]);
      ranges("Custom", [length, at]);
    }
    ranges("Patterns", [length]);
    ranges("ListPatterns", [length]);
    ranges("Declared", [length]);
  }
  for (let value = -1; value < 12; value++) {
    ranges("IndexMembers", [value]);
    ranges("Texts", [value]);
    ranges("TextOf", [value]);
    ranges("Strings", [value]);
    for (let back = -1; back < 20; back += 3) {
      ranges("Substrings", [value, back]);
      ranges("RangeValues", [value, back, 10]);
    }
    ranges("StringPatterns", [value]);
  }
  for (const a of [-1, 0, 1, 2, 3, 4, 6, 9]) {
    for (const b of [-1, 0, 1, 2, 3, 4, 6, 9]) {
      ranges("Struct", [a, b]);
      ranges("Nested", [a, b]);
      ranges("Tuples", [a, b]);
      ranges("TuplePattern", [a, b]);
    }
  }
  for (let which = 0; which < 11; which++) ranges("Faults", [which]);

  // tests/Regressions.cs: what the differential fuzzer found.
  const regression = (method, args = []) =>
    add("regressions", "Tests.Regressions.Regressions", method, args);
  for (let k = -1; k < 11; k++) {
    regression("UnboxedDeclaration", [k]);
    regression("UnionConstructor", [k]);
    regression("IterationVariable", [k < 0 ? 0 : k]);
    regression("ObjectConstants", [k < 0 ? 9 : k]);
    regression("ObjectRelations", [k < 0 ? 9 : k]);
    regression("Generic", [k < 0 ? 9 : k]);
    regression("UnionConstants", [k]);
    regression("CapturedByReference", [k]);
  }
  for (const x of [-2, -1, 0, 1, 2, 3, 5]) regression("BoxedStructKeys", [x]);
  for (let left = 0; left < 18; left++) {
    for (let right = 0; right < 18; right++) {
      regression("CompareOrdinal", [left, right]);
      regression("CompareOrdinalComparison", [left, right]);
      regression("CompareIgnoreCase", [left, right]);
    }
  }
  for (const x of [0, -0, 1, -1, 2.5, 65.7, NaN, Infinity]) {
    for (const y of [0, -0, 1, 2.5, 65.2, NaN]) {
      regression("ScalarEquals", [x, y]);
    }
  }

  // tests/Initializers.cs: nested member initializers and collection
  // expressions, with spreads, capacities and evaluation order.
  const collectionInit = (method, args = []) =>
    add("initializers", "Tests.Initializers.Initializers", method, args);
  for (const x of [-4, 0, 1, 2, 3, 5, 9, 1000]) {
    for (
      const method of [
        "Nested",
        "NullMember",
        "Arrays",
        "Lists",
        "Sets",
        "AddOrder",
        "Order",
      ]
    ) {
      collectionInit(method, [x]);
    }
  }
  for (let which = 0; which < 10; which++) {
    collectionInit("SpreadFaults", [which]);
  }

  // tests/Numerics.cs: the numeric types' generic math statics, HashCode
  // and string hashing.
  const numerics = (method, args = [], policy = null) =>
    add("numerics", "Tests.Numerics.Numerics", method, args, policy);
  for (const a of [-128, -127, -5, -1, 0, 1, 2, 3, 64, 127]) {
    for (const b of [-128, -127, -5, -1, 0, 1, 2, 3, 64, 127]) {
      for (let which = 0; which < 21; which++) {
        numerics("SByte", [which, a, b]);
      }
    }
  }
  for (const a of [0, 1, 2, 3, 64, 128, 255]) {
    for (const b of [0, 1, 2, 3, 64, 128, 255]) {
      for (let which = 0; which < 15; which++) {
        numerics("Byte", [which, a, b]);
      }
    }
  }
  for (const a of [-32768, -7, -1, 0, 1, 6, 1024, 32767]) {
    for (const b of [-32768, -7, -1, 0, 1, 6, 1024, 32767]) {
      for (let which = 0; which < 21; which++) {
        numerics("Int16", [which, a, b]);
      }
    }
  }
  for (const a of [0, 1, 6, 1024, 32768, 65535]) {
    for (const b of [0, 1, 6, 1024, 32768, 65535]) {
      for (let which = 0; which < 15; which++) {
        numerics("UInt16", [which, a, b]);
      }
    }
  }
  for (const a of [-2147483648, -7, -1, 0, 1, 6, 1024, 2147483647]) {
    for (const b of [-2147483648, -7, -1, 0, 1, 6, 1024, 2147483647]) {
      for (let which = 0; which < 21; which++) {
        numerics("Int32", [which, a, b]);
      }
    }
  }
  for (const a of [0, 1, 6, 1024, 2147483648, 4294967295]) {
    for (const b of [0, 1, 6, 1024, 2147483648, 4294967295]) {
      for (let which = 0; which < 15; which++) {
        numerics("UInt32", [which, a, b]);
      }
    }
  }
  for (
    const a of [
      -9223372036854775808n,
      -7n,
      -1n,
      0n,
      1n,
      6n,
      4294967296n,
      9223372036854775807n,
    ]
  ) {
    for (
      const b of [
        -9223372036854775808n,
        -7n,
        -1n,
        0n,
        1n,
        6n,
        4294967296n,
        9223372036854775807n,
      ]
    ) {
      for (let which = 0; which < 21; which++) {
        numerics("Int64", [which, a, b]);
      }
    }
  }
  for (
    const a of [
      0n,
      1n,
      6n,
      4294967296n,
      9223372036854775808n,
      18446744073709551615n,
    ]
  ) {
    for (
      const b of [
        0n,
        1n,
        6n,
        4294967296n,
        9223372036854775808n,
        18446744073709551615n,
      ]
    ) {
      for (let which = 0; which < 15; which++) {
        numerics("UInt64", [which, a, b]);
      }
    }
  }
  for (
    const a of [
      0,
      -0,
      0.5,
      -0.5,
      1.5,
      2.5,
      -2.5,
      3,
      4,
      -7.25,
      1e-310,
      1e300,
      Infinity,
      -Infinity,
      NaN,
    ]
  ) {
    for (const b of [0, -0, 1.5, -2, NaN, Infinity]) {
      for (let which = 0; which < 31; which++) {
        // A NaN's sign is the harness's, not the CLR's float.NaN's.
        if (which === 5 && Number.isNaN(b)) continue;
        if ((which === 13 || which === 14) && Number.isNaN(a)) continue;
        numerics(
          "Single",
          [which, Math.fround(a), Math.fround(b)],
          which >= 28 ? { ulps: 1, single: true } : null,
        );
      }
    }
  }
  for (
    const a of [
      0,
      -0,
      0.5,
      -0.5,
      1.5,
      2.5,
      -2.5,
      3,
      4,
      -7.25,
      1e-310,
      1e300,
      Infinity,
      -Infinity,
      NaN,
    ]
  ) {
    for (const b of [0, -0, 1.5, -2, NaN, Infinity]) {
      for (let which = 0; which < 31; which++) {
        // A NaN's sign is the harness's, not the CLR's float.NaN's.
        if (which === 5 && Number.isNaN(b)) continue;
        if ((which === 13 || which === 14) && Number.isNaN(a)) continue;
        numerics("Double", [which, a, b], which >= 28 ? { ulps: 1 } : null);
      }
    }
  }
  for (const a of [-3, 0, 7, 100000]) {
    for (const b of [-1, 0, 5]) numerics("Hashes", [a, b]);
  }
  numerics("NullHash", [0]);
  numerics("NullHash", [1]);

  // tests/Dispatch.cs: covariant returns, default interface members,
  // interface statics, static abstract members and generic virtual methods.
  const dispatch = (method, args = []) =>
    add("dispatch", "Tests.Dispatch.Dispatch", method, args);
  for (const a of [0, 15, 20, 50, 51, 90]) {
    for (const b of [0, 15, 20, 50, 51, 90]) dispatch("Truth", [a, b]);
  }
  for (const value of [-2, 0, 1, 2, 3, 7]) {
    for (
      const method of [
        "Covariant",
        "Defaults",
        "Statics",
        "GenericDefault",
        "StaticAbstract",
        "GenericVirtual",
        "AbstractGeneric",
        "GenericClassVirtual",
        "InterfaceGeneric",
      ]
    ) {
      dispatch(method, [value]);
    }
  }

  // tests/Types.cs: typeof, GetType and System.Type's members.
  const types = (method, args = [], policy = null) =>
    add("types", "Tests.Types.Types", method, args, policy);
  for (let which = 0; which < 25; which++) {
    types("Flags", [which]);
    types("Texts", [which]);
    types("BaseTypes", [which]);
    if (![13, 14, 15, 17, 21].includes(which)) types("FullName", [which]);
    for (let other = 0; other < 25; other += 4) {
      types("Identity", [which, other]);
    }
  }
  for (let which = 0; which < 16; which++) types("GetTypes", [which]);
  for (const which of [-1, 0, 1, 2]) {
    types("StaticGetType", [which]);
    types("Generic", [which]);
    types("Keyed", [which]);
  }
  types("Faults", [0]);
  types("Faults", [1]);
  types("Faults", [2], {
    fault: 17,
    reason:
      "A generic instantiation's FullName names assemblies a module has none of.",
  });

  // tests/EnumMembers.cs: Enum.Parse, TryParse, GetNames, GetValues,
  // GetName and IsDefined.
  const enumMember = (method, args = []) =>
    add("enum-members", "Tests.EnumMembers.EnumMembers", method, args);
  for (let which = 0; which < 5; which++) {
    for (let input = 0; input < 33; input++) {
      for (const ignoreCase of [0, 1]) {
        enumMember("Parse", [which, input, ignoreCase]);
        enumMember("TryParse", [which, input, ignoreCase]);
      }
    }
    enumMember("Names", [which]);
    enumMember("Values", [which]);
  }
  for (const value of [-128, -3, -1, 0, 1, 2, 3, 5, 7, 8, 127, 255]) {
    enumMember("Named", [value]);
  }

  // tests/References.cs: references to array elements, fields, statics and
  // variables, as ref arguments, ref locals and ref returns.
  const refCase = (method, args = []) =>
    add("references", "Tests.References.References", method, args);
  for (const x of [-3, -1, 0, 1, 2, 3, 100]) {
    for (
      const method of [
        "Elements",
        "Fields",
        "Locals",
        "Returns",
        "Captured",
        "ReadOnly",
      ]
    ) {
      refCase(method, [x]);
    }
  }
  for (let which = 0; which < 4; which++) refCase("Faults", [which]);
  for (let which = 0; which < 2; which++) refCase("Parsed", [which]);

  // tests/Enumerables.cs: IEnumerable<T>, IEnumerator<T> and IDisposable
  // over classes, arrays, strings and the collections.
  for (const x of [-7, -1, 0, 1, 2, 3, 12]) {
    for (
      const method of [
        "Sources",
        "Strings",
        "Manual",
        "Tests",
        "Disposing",
        "DisposingAfter",
      ]
    ) {
      add("enumerables", "Tests.Enumerables.Enumerables", method, [x]);
    }
  }

  // tests/Iterators.cs: yield return and yield break in methods, accessors
  // and generic, virtual and nested iterators, across loops, switches,
  // using, lock and try/finally statements, with disposal and exceptions.
  for (const x of [-3, 0, 1, 2, 3, 4, 7, 12]) {
    for (
      const method of [
        "Basic",
        "Composed",
        "Finally",
        "Exceptions",
        "Statements",
        "Enumerators",
        "Classes",
        "Deconstructing",
        "StructIterators",
        "LocalIterators",
        "Jumps",
      ]
    ) {
      add("iterators", "Tests.Iterators.Iterators", method, [x]);
    }
  }
  add("iterators", "Tests.Iterators.Iterators", "Fuel", [1000]);
  add("iterators", "Tests.Iterators.Iterators", "Fuel", [2000000], {
    fault: 1,
    reason: "An endless iterator spends the control-step fuel budget.",
  });

  // tests/Linq.cs: System.Linq's operators, query expressions, deferred
  // execution and the exceptions the operators throw.
  for (const x of [-7, -1, 0, 1, 2, 3, 5, 11]) {
    for (
      const method of [
        "Filtering",
        "Sets",
        "Ordering",
        "Grouping",
        "Elements",
        "Aggregates",
        "Averages",
        "Queries",
        "Deferred",
        "Collections",
        "Joins",
        "Casts",
      ]
    ) {
      add("linq", "Tests.Linq.Linq", method, [x]);
    }
  }
  for (let which = 0; which <= 12; which++) {
    add("linq", "Tests.Linq.Linq", "Faults", [which]);
  }

  // tests/Anonymous.cs: anonymous types' members, equality, hashing and
  // text, as keys, and in query expressions.
  for (const x of [-9, -1, 0, 1, 2, 3, 7, 40]) {
    for (
      const method of ["Members", "Hashes", "Collections", "Queries", "Shapes"]
    ) {
      add("anonymous", "Tests.Anonymous.Anonymous", method, [x]);
    }
  }

  // tests/UnprintedRecords.cs: derived records whose floating members
  // nothing prints (a fuzzer finding: their formatter went unregistered).
  for (const x of [-3, 0, 1, 7]) {
    add(
      "unprinted-records",
      "Tests.UnprintedRecords.UnprintedRecords",
      "Values",
      [x],
    );
  }

  // tests/ManyTypes.cs: a module of more than 1024 GC types.
  for (const x of [0, 7]) {
    add("many-types", "Tests.ManyTypes.ManyTypes", "Sum", [x]);
  }

  // tests/MultiArrays.cs: multidimensional arrays: creation, initializers,
  // element access and checks, foreach, System.Array members.
  for (const x of [-5, 0, 1, 2, 3, 6, 13, 15]) {
    for (
      const method of [
        "Grid",
        "Initialized",
        "Elements",
        "Order",
        "Generic",
        "Objects",
      ]
    ) {
      add("multi-arrays", "Tests.MultiArrays.MultiArrays", method, [x]);
    }
  }
  for (let which = 0; which <= 8; which++) {
    add("multi-arrays", "Tests.MultiArrays.MultiArrays", "Faults", [which]);
  }

  // tests/Comparers.cs: IComparer, IEqualityComparer and IComparable, the
  // ordinal string comparers, the operators and collections taking them,
  // lookups, interface indexers, the default equality of structs with
  // Equals(object) of their own, and the default order through a base
  // class's IComparable<T>.
  for (const x of [-5, -1, 0, 1, 2, 3, 6, 11]) {
    for (
      const method of [
        "Ordinal",
        "Custom",
        "Comparable",
        "Lookups",
        "HashSets",
        "Indexers",
        "ObjectEquality",
        "Contravariant",
        "NullablesAndLegacy",
        "Reimplementations",
      ]
    ) {
      add("comparers", "Tests.Comparers.Comparers", method, [x]);
    }
  }
  for (let which = 0; which <= 4; which++) {
    add("comparers", "Tests.Comparers.Comparers", "Faults", [which]);
  }

  // tests/MoreCollections.cs: PriorityQueue, SortedList, SortedDictionary,
  // SortedSet and LinkedList.
  for (const x of [-4, -1, 0, 1, 2, 3, 7, 12]) {
    for (const method of ["Priorities", "Sorted", "Views", "Linked"]) {
      add("more-collections", "Tests.MoreCollections.MoreCollections", method, [
        x,
      ]);
    }
  }
  for (let which = 0; which <= 8; which++) {
    add("more-collections", "Tests.MoreCollections.MoreCollections", "Faults", [
      which,
    ]);
  }

  // tests/Spans.cs: Span<T>, ReadOnlySpan<T>, stackalloc, MemoryExtensions
  // and CollectionsMarshal.AsSpan.
  for (const x of [-3, 0, 1, 2, 5, 9]) {
    for (const method of ["Views", "Copies", "Searching", "Text", "Structs"]) {
      add("spans", "Tests.Spans.Spans", method, [x]);
    }
  }
  for (let which = 0; which <= 7; which++) {
    add("spans", "Tests.Spans.Spans", "Faults", [which]);
  }

  // tests/Decimals.cs: decimal against the CLR: arithmetic on values of
  // every shape, conversions, rounding, text, parsing, hashing, the
  // exceptions' messages and faults, and decimal in the language.
  const decimals = (method, args = []) =>
    add("decimals", "Tests.Decimals.Decimals", method, args);
  for (let seed = 0; seed < 2000; seed++) {
    for (
      const method of ["Add", "Subtract", "Multiply", "Divide", "Remainder"]
    ) decimals(method, [seed]);
  }
  for (let seed = 0; seed < 600; seed++) {
    for (
      const method of [
        "Operators",
        "Compare",
        "Hash",
        "FromDouble",
        "FromSingle",
        "ToDouble",
        "ToSingle",
        "ToIntegers",
        "FromIntegers",
        "Rounding",
        "Members",
        "Text",
        "Format",
        "Interpolation",
        "Parse",
        "Styles",
        "PartialStyles",
        "Providers",
        "GenericMath",
        "GenericConversions",
      ]
    ) decimals(method, [seed]);
  }
  for (let which = 0; which < 23; which++) decimals("Messages", [which]);
  for (let which = 0; which < 4; which++) decimals("Faults", [which]);
  for (let which = 0; which < 15; which++) decimals("Language", [which]);
  for (const x of [-400, -2, 0, 1, 2, 3, 250, 300, 30000]) {
    decimals("Enums", [x]);
  }

  // tests/InterfaceEvents.cs: events declared by interfaces, implemented
  // field-like, with accessors, explicitly and by default bodies.
  for (const x of [-3, 0, 1, 2, 5, 9]) {
    for (const method of ["Field", "Accessors", "Inherited", "Defaults"]) {
      add("interface-events", "Tests.InterfaceEvents.InterfaceEvents", method, [
        x,
      ]);
    }
  }
  add("interface-events", "Tests.InterfaceEvents.InterfaceEvents", "Missing", [
    0,
  ]);
  add("interface-events", "Tests.InterfaceEvents.InterfaceEvents", "Missing", [
    1,
  ]);

  // tests/Memories.cs: Memory<T> and ReadOnlyMemory<T>.
  for (const x of [-2, 0, 1, 3, 6, 13]) {
    for (const method of ["Arrays", "Strings", "Storage", "Text"]) {
      add("memories", "Tests.Memories.Memories", method, [x]);
    }
  }
  for (let which = 0; which < 8; which++) {
    add("memories", "Tests.Memories.Memories", "Checks", [which]);
  }

  // tests/Converts.cs: System.Convert between every pair of bool, char,
  // the integer types, float, double, decimal and string.
  {
    const counts = [2, 5, 5, 4, 5, 4, 6, 4, 5, 4, 11, 16, 10, 13];
    for (let target = 0; target < 14; target++) {
      for (let source = 0; source < 14; source++) {
        for (let index = 0; index < counts[source]; index++) {
          add("converts", "Tests.Converts.Converts", "Run", [
            target,
            source,
            index,
          ]);
        }
      }
    }
  }

  // tests/Statements.cs: using and lock statements, foreach over strings,
  // and new object().
  for (const a of [-3, 0, 1, 2, 3, 9, 42, 5000]) {
    for (
      const method of [
        "UsingBlock",
        "UsingMany",
        "UsingDeclarations",
        "UsingAfterReturn",
        "UsingNull",
        "UsingExpression",
        "UsingVirtual",
        "UsingThrows",
        "UsingLoop",
        "Locked",
        "Characters",
        "Objects",
        "DisposingLoops",
        "DisposingReturn",
        "DisposingReturnAfter",
      ]
    ) {
      add("statements", "Tests.Statements.Statements", method, [a]);
    }
  }

  // tests/Parameters.cs: params arrays, optional and named arguments, and
  // in parameters.
  for (const a of [-5, 0, 1, 2, 9, 1000]) {
    for (
      const method of [
        "ParamsCounts",
        "ParamsStrings",
        "AllDefaults",
        "SomeDefaults",
        "NamedOrder",
        "InParameters",
        "Delegates",
        "Virtuals",
        "Constructors",
        "ExtensionParams",
        "LocalFunctions",
      ]
    ) {
      add("parameters", "Tests.Parameters.Parameters", method, [a]);
    }
  }

  // tests/Combinations.cs: generics, structs, collections and exceptions
  // used together.
  for (const value of [-3, 0, 1, 2, 5, 8]) {
    for (
      const method of [
        "GenericStructs",
        "NestedCollections",
        "GenericStatics",
        "Inventory",
        "StructsInClosuresAndCollections",
        "ExceptionsInGenericCode",
        "EnumeratorOverStructs",
      ]
    ) {
      add("combinations", "Tests.Combinations.Combinations", method, [value]);
    }
  }

  // tests/Strings.cs: literals, equality, concatenation, formatting of
  // integers, bools and chars, interpolation, switches on strings, members,
  // and strings as collection elements and keys.
  const strings = (method, args = []) =>
    add("strings", "Tests.StringTypes.Strings", method, args);
  for (let which = 0; which < 10; which++) {
    for (
      const method of [
        "Literals",
        "Equality",
        "Integers",
        "Switches",
        "Substrings",
      ]
    ) {
      strings(method, [which]);
    }
  }
  for (const value of [-2147483648, -7, 0, 1, 6, 9, 2147483647]) {
    for (const method of ["Concatenation", "Interpolation", "Fields"]) {
      strings(method, [value]);
    }
  }
  for (const index of [-1, 0, 3, 5, 6]) strings("Indexer", [index]);
  for (const start of [0, 3, 16, 17]) strings("Members", [start]);
  for (const count of [0, 1, 4, 12]) strings("Collections", [count]);
  for (const which of [0, 1, 2, 3]) strings("Exceptions", [which]);
  strings("NullLength");

  // tests/TypeInitialization.cs: when static constructors run, in which
  // order, what a failing initializer throws, at first use and after. Each
  // class is initialized once for the whole run, so the order of these
  // cases is part of the test.
  add("type-initialization", "Tests.TypeInitialization.Broken", "Read");
  add("type-initialization", "Tests.TypeInitialization.Broken", "Catch");
  add("type-initialization", "Tests.TypeInitialization.Broken", "Read");
  for (
    const method of [
      "StaticMethod",
      "FieldAccess",
      "Construction",
      "Cycles",
      "Failures",
      "FailuresLater",
      "FailureEscapes",
      "FailuresLater",
      "FailingFirstUse",
      "FailingAgain",
      "Nested",
      "Nested",
      "Structs",
      "Generics",
      "InstanceConstruction",
    ]
  ) {
    add(
      "type-initialization",
      "Tests.TypeInitialization.Initialization",
      method,
    );
  }
  for (const value of [-7, -1, 0, 1, 2, 3, 4, 5, 6, 9]) {
    for (
      const method of [
        "ReturnThroughFinally",
        "LoopsThroughFinally",
        "Filters",
        "AcrossCalls",
        "ThrowExpressions",
        "Constructors",
        "MutationsSurvive",
        "InsideCatch",
        "CapturedCatchVariable",
      ]
    ) {
      exceptions(method, [value]);
    }
  }
  collections("NullIndexer");
  for (const value of [-9, 0, 4, 2147483647]) collections("Indexers", [value]);

  // tests/GenericMath.cs: INumber<T> and the conversions.
  {
    const math = (method, args) =>
      add("generic-math", "Tests.GenericMath.GenericMath", method, args);
    for (
      const a of [
        -2147483648,
        -300,
        -7,
        -1,
        0,
        1,
        2,
        5,
        128,
        255,
        70000,
        2147483647,
      ]
    ) {
      for (const method of ["Integers", "Longs", "SmallIntegers", "Doubles"]) {
        math(method, [a]);
      }
    }
    for (let which = 0; which < 11; which++) {
      for (const method of ["Checks", "Saturations", "Truncations"]) {
        math(method, [which]);
      }
    }
  }

  // tests/WideMath.cs: generic math over nint, nuint, Int128, UInt128 and
  // Half, their conversions and their text.
  {
    const wide = (method, args) =>
      add("wide-math", "Tests.WideMath.WideMath", method, args);
    for (
      const a of [
        -2147483648,
        -300,
        -7,
        -1,
        0,
        1,
        2,
        5,
        128,
        70000,
        2147483647,
      ]
    ) {
      for (
        const method of [
          "NativeIntegers",
          "NativeUnsigned",
          "WideIntegers",
          "WideUnsigned",
        ]
      ) {
        wide(method, [a]);
      }
    }
    for (let i = 0; i < 26; i++) {
      for (let j = 0; j < 26; j += 5) wide("Halves", [i, j]);
    }
    for (let block = 0; block < 256; block++) wide("HalfTexts", [block]);
    for (let op = 0; op < 10; op++) {
      for (let i = 0; i < 45; i++) wide("HalfParsing", [op, i]);
      for (let i = 0; i < 41; i++) wide("WideParsing", [op, i]);
    }
    for (let op = 0; op < 32; op++) {
      for (let i = 0; i < 14; i++) wide("WideFormatting", [op, i]);
    }
    for (let from = 0; from < 17; from++) {
      for (let to = 0; to < 17; to++) {
        for (let mode = 0; mode < 3; mode++) {
          wide("Conversions", [from, to, mode]);
        }
      }
    }
  }

  // tests/IlAccepted.cs: the accepted cases of tests/rejections.mjs, which
  // the retired IOperation frontend rejected.
  {
    const accepted = (method, args) =>
      add("il-accepted", "Tests.IlAccepted.IlAccepted", method, args);
    for (let which = 0; which < 5; which++) {
      accepted("DelegateCombine", [which]);
    }
    for (
      const [x, y] of [
        [5, 2],
        [7, 2],
        [-7.5, 2],
        [1e300, 3],
        [0.1, 0.03],
        [-0, 1],
        [3, 0],
        [Infinity, 2],
        [2, Infinity],
      ]
    ) {
      accepted("IeeeRemainder", [x, y]);
    }
    for (
      const [x, y, z] of [
        [1 + 2 ** -30, 1 + 2 ** -30, -1],
        [0.1, 10, -1],
        [1e308, 10, -Infinity],
        [3, 4, 5],
        [1e-200, 1e-100, 1e-300],
        [-2.5, 0.1, 0.25],
      ]
    ) {
      accepted("FusedMultiplyAdd", [x, y, z]);
      accepted("FusedMultiplyAddSingle", [
        Math.fround(x),
        Math.fround(y),
        Math.fround(z),
      ]);
    }
    for (const x of [-3, 0, 7]) {
      accepted("AsyncMethods", [x]);
    }
    for (let which = 0; which < 4; which++) accepted("Unions", [which]);
    for (let which = 0; which < 7; which++) accepted("TypeNames", [which]);
    for (let which = 0; which < 5; which++) accepted("Variance", [which]);
    for (let which = 0; which < 4; which++) {
      accepted("DelegateVariance", [which]);
    }
    for (let which = 0; which < 9; which++) {
      accepted("ArrayCovariance", [which]);
    }
    accepted("Casts");
    for (const x of [-3, 0, 1, 2, 9]) {
      accepted("Boxing", [x]);
      accepted("CompoundUserConversion", [x]);
      accepted("PrimaryConstructor", [x]);
      accepted("Filters", [x]);
      accepted("Equatable", [x]);
      accepted("GenericLocalFunctions", [x]);
      accepted("GenericConstraints", [x]);
      accepted("GenericMathDecimal", [x]);
      accepted("StructMethodGroup", [x]);
      accepted("Formatting", [x]);
      accepted("StructBoxing", [x]);
      accepted("StructBoxingUnbox", [x]);
      accepted("ThreadStatic", [x]);
      accepted("Volatile", [x]);
    }
    for (const count of [0, 1, 3, 5]) {
      accepted("CaptureLoopCondition", [count]);
      accepted("CollectionInterface", [count]);
      accepted("StaticInterfaceEvent", [count]);
    }
    accepted("CallerInfo");
    accepted("Attributes", [3]);
    accepted("SourceAttributes", [21]);
    accepted("VirtualEvent", [0]);
    accepted("VirtualEvent", [1]);
  }

  // tests/IlRegressions.cs.
  for (const x of [-2, 0, 1, 4, 9]) {
    for (
      const method of [
        "StackallocAcrossBranches",
        "RecordNull",
        "AutoProperties",
        "EagerStatics",
        "BoxedInterfaces",
        "FoldedTry",
        "FieldlessStructs",
        "ExceptionTypes",
        "SortedStrings",
        "ArrayInterfaceEquality",
        "CaughtDepth",
      ]
    ) {
      add("il-regressions", "Tests.IlRegressions.IlRegressions", method, [x]);
    }
  }

  // tests/Sharing.cs: shared generics' code over several
  // reference types, and what it asks of each exact type argument.
  {
    const sharing = (method, count) => {
      for (let which = 0; which < count; which++) {
        add("sharing", "Tests.Sharing.Sharing", method, [which]);
      }
    };
    sharing("Boxes", 7);
    sharing("Methods", 5);
    sharing("Comparers", 7);
    sharing("Statics", 3);
    sharing("Virtuals", 3);
    sharing("Variance", 3);
    sharing("Nested", 3);
  }

  // tests/Equatables.cs: IEquatable<T> types whose
  // Equals(T) and Equals(object) disagree, through EqualityComparer<T>'s
  // default, the collections, System.Linq and shared generic code.
  for (const x of [-5, -1, 0, 1, 2, 3, 6, 11]) {
    for (
      const method of [
        "Comparer",
        "Collections",
        "Linq",
        "Shared",
        "Composites",
      ]
    ) {
      add("equatables", "Tests.Equatables.Equatables", method, [x]);
    }
  }

  // tests/Simd.cs: Vector128 against the CLR's hardware
  // accelerated one, lanes hashed by their bits (NaN as one NaN).
  {
    const simd = (method, args, policy = null) =>
      add("simd", "Tests.Simd.Simd", method, args, policy);
    const seeds = Array.from({ length: 20 }, (_, i) => i);
    for (let op = 0; op <= 30; op++) {
      for (const i of seeds) {
        for (const j of [0, 7, 13]) simd("FloatBinary", [op, i, j]);
      }
    }
    for (let op = 0; op <= 38; op++) {
      for (const i of seeds) simd("FloatUnary", [op, i]);
    }
    for (const op of [0, 24, 29]) {
      for (const i of seeds) {
        for (let lane = 0; lane < 4; lane++) {
          simd("FloatBinaryLane", [op, i, 7, lane]);
        }
      }
    }
    for (const op of [0, 6, 7, 8, 9]) {
      for (const i of seeds) {
        for (let lane = 0; lane < 4; lane++) {
          simd("FloatUnaryLane", [op, i, lane]);
        }
      }
    }
    for (let op = 0; op <= 21; op++) {
      for (const i of seeds) {
        for (const j of [0, 4, 9]) simd("FloatTests", [op, i, j]);
      }
    }
    for (const i of seeds) {
      for (const j of [0, 1, 2, 5]) simd("FloatIndex", [i, j]);
    }
    // MinNative and MaxNative of ordered, distinct lanes; the estimates of
    // exact products and sums; as the CLR defines them to be alike.
    for (let op = 0; op <= 2; op++) {
      for (let i = 0; i < 10; i++) {
        for (const j of [0, 3, 6]) simd("Native", [op, i, j]);
      }
    }
    for (let op = 0; op <= 3; op++) {
      for (const i of [-3, 0, 1, 2, 5, 8]) simd("Estimates", [op, i]);
    }
    // The transcendental functions, element by element here and
    // vectorized approximations of the CLR's own there.
    for (let op = 0; op <= 8; op++) {
      for (let lane = 0; lane < 4; lane++) {
        for (const x of [0, 0.5, -1.25, 3, 10, 1e-3]) {
          simd("Transcendental", [op, lane, Math.fround(x)], {
            ulps: op >= 7 ? 0 : 2,
            single: true,
          });
        }
      }
    }
    for (let op = 0; op <= 4; op++) {
      for (let lane = 0; lane < 2; lane++) {
        for (const x of [0, 0.5, -1.25, 3, 10, 1e-3]) {
          simd("TranscendentalDouble", [op, lane, x], { ulps: 2 });
        }
      }
    }
    for (let op = 0; op <= 22; op++) {
      for (const i of seeds) {
        for (const j of [0, 3, 11]) simd("DoubleBinary", [op, i, j]);
      }
    }
    const integers = [
      "SBytes",
      "Bytes",
      "Shorts",
      "UShorts",
      "Ints",
      "UInts",
      "Longs",
      "ULongs",
    ];
    for (const method of integers) {
      for (let op = 0; op <= 41; op++) {
        for (const i of [0, 3, 5, 8, 13, 17, 21]) {
          for (const j of [0, 2, 9, 19]) simd(method, [op, i, j]);
        }
      }
    }
    for (const i of [0, 1, 5]) simd("DivideByZero", [i]);
    for (let op = 0; op <= 21; op++) {
      for (const i of [0, 4, 9, 16]) {
        for (const j of [1, 7]) simd("Conversions", [op, i, j]);
      }
    }
    for (let op = 0; op <= 11; op++) {
      for (const i of [0, 6, 11]) {
        for (const j of [2, 14]) simd("Rearrange", [op, i, j]);
      }
    }
    for (let op = 0; op <= 17; op++) {
      for (const i of [0, 1, 2, 3, 15]) simd("Elements", [op, i]);
    }
    for (const index of [-1, 0, 3, 4, 100]) {
      simd("ElementOutOfRange", [index]);
      simd("IndexerOutOfRange", [index]);
      simd("WithElementOutOfRange", [index]);
    }
    for (let op = 0; op <= 5; op++) {
      for (const length of [3, 4, 5, 8]) simd("Copies", [op, length]);
    }
    for (const i of [0, 1, 7, 15, 19]) {
      simd("TextLength", [i]);
      simd("TextHash", [i]);
    }
    for (let op = 0; op <= 7; op++) {
      for (const n of [1, 3, 8]) simd("Values", [op, n]);
    }
    for (const offset of [0, 1, 4]) simd("Memory", [offset]);
  }

  // tests/Vectors.cs: System.Numerics' vectors, quaternions,
  // planes and matrices, exact but for what takes a sine, cosine or tangent.
  {
    const vectors = (method, args, policy = null) =>
      add("vectors", "Tests.Vectors.Vectors", method, args, policy);
    const seeds = [0, 1, 2, 5, 9, 17, 23, 40];
    for (
      const [method, count] of [
        ["Vector2Ops", 40],
        ["Vector3Ops", 30],
        ["Vector4Ops", 22],
        ["Rotations", 22],
        ["Matrix3x2Ops", 18],
        ["Matrix4x4Ops", 26],
      ]
    ) {
      for (let op = 0; op < count; op++) {
        for (const i of seeds) {
          for (const j of [3, 11, 30]) vectors(method, [op, i, j]);
        }
      }
    }
    for (const [row, column] of [[0, 0], [2, 1], [3, 0], [0, 2], [-1, 0]]) {
      vectors("Matrix3x2OutOfRange", [row, column]);
    }
    for (const [row, column] of [[0, 0], [3, 3], [4, 0], [0, 4], [-1, 1]]) {
      vectors("Matrix4x4OutOfRange", [row, column]);
    }
    for (const row of [-1, 0, 3, 4]) vectors("Matrix4x4RowOutOfRange", [row]);
    for (let op = 0; op <= 13; op++) {
      for (const component of [0, 1, 5, 10, 13]) {
        for (const angle of [0.5, 1, 2.25, 0.3]) {
          vectors("Trigonometry", [op, component, Math.fround(angle)], {
            ulps: 8,
            single: true,
          });
        }
      }
    }
    for (let op = 0; op <= 7; op++) {
      for (const i of [0, 3, 8]) vectors("TextHash", [op, i]);
    }
    for (let op = 0; op <= 4; op++) {
      for (const length of [2, 3, 4, 6]) vectors("Copies", [op, length]);
    }
    for (let op = 0; op <= 3; op++) {
      for (const n of [1, 2, 6]) vectors("Values", [op, n]);
    }
  }

  // tests/BigIntegers.cs: BigInteger's arithmetic, conversions, text and
  // generic math, as digests; its logarithms and conversions to double
  // within an ulp.
  {
    const big = (method, args, policy = null) =>
      add(
        "big-integers",
        "Tests.BigIntegers.BigIntegers",
        method,
        args,
        policy,
      );
    for (let op = 0; op <= 28; op++) {
      for (let i = 0; i < 30; i++) {
        for (const j of [0, 1, 2, 4, 7, 9, 12, 15, 18, 20, 22, 27]) {
          big("Arithmetic", [op, i, j]);
        }
      }
    }
    for (let op = 0; op <= 6; op++) {
      for (let i = 0; i < 30; i++) big("Logarithms", [op, i], { ulps: 1 });
    }
    for (let op = 0; op <= 19; op++) {
      for (let i = 0; i < 30; i++) big("Conversions", [op, i]);
    }
    for (let op = 0; op < 33; op++) {
      for (let i = 0; i < 30; i++) big("Formatting", [op, i]);
    }
    for (let i = 0; i < 30; i++) big("Texts", [i]);
    for (let op = 0; op < 12; op++) {
      for (let i = 0; i < 34; i++) big("Parsing", [op, i]);
    }
    for (let i = 0; i < 30; i++) {
      for (let format = 0; format < 5; format++) big("RoundTrips", [i, format]);
    }
    for (let i = 0; i < 24; i++) {
      for (const j of [0, 3, 8, 14, 17, 22]) big("GenericMath", [i, j]);
    }
    for (const count of [0, 1, 10, 50, 200]) big("Collections", [count]);
  }

  // tests/Complexes.cs: Complex's arithmetic and functions a part at a
  // time (the elementary functions within a few ulps: the CoreLib's
  // transcendentals are not the CLR's), its predicates, text and generic
  // math.
  {
    const complex = (method, args, policy = null) =>
      add("complexes", "Tests.Complexes.Complexes", method, args, policy);
    for (let op = 0; op <= 30; op++) {
      for (let i = 0; i < 16; i++) {
        for (const j of [0, 1, 3, 4, 7, 9, 12, 14]) {
          for (const part of [0, 1]) {
            complex(
              "Operations",
              [op, i, j, part],
              op >= 8 ? { ulps: 4 } : { ulps: 1 },
            );
          }
        }
      }
    }
    for (let i = 0; i < 16; i++) {
      for (const j of [0, 1, 3, 6, 9, 14]) complex("Predicates", [i, j]);
    }
    for (let op = 0; op < 13; op++) {
      for (let i = 0; i < 16; i++) complex("Formatting", [op, i]);
    }
    for (let op = 0; op < 5; op++) {
      for (let i = 0; i < 14; i++) complex("Parsing", [op, i]);
    }
    for (let i = 0; i < 16; i++) {
      for (const j of [0, 2, 5, 9]) {
        for (let part = 0; part < 6; part++) {
          complex("Generic", [i, j, part], { ulps: 2 });
        }
      }
    }
  }

  // tests/Async.cs: async methods and the task library
  // under a single-threaded context of the case's own, and the frame loop.
  {
    const async = (method, count) => {
      for (let which = 0; which < count; which++) {
        add("async", "Tests.Async.Async", method, [which]);
        add("async-runtime", "Tests.Async.Async", method, [which]);
      }
    };
    async("Basics", 16);
    async("Exceptions", 13);
    async("Combinators", 9);
    async("Cancellation", 9);
    async("Iterators", 9);
    async("FrameLoop", 5);
    async("Shapes", 8);
    async("Contexts", 9);
    async("Waits", 3);
    async("Schedulers", 9);
  }

  // tests/Libraries.cs: a module over two gameplay libraries.
  for (
    const method of [
      "Areas",
      "Descriptions",
      "Sorting",
      "Equality",
      "Generics",
      "GenericVirtuals",
      "Reimplemented",
      "Delegates",
      "Iterators",
      "Exceptions",
      "Async",
      "Internals",
    ]
  ) {
    for (const n of [0, 1, 2, 3, 4, 5, 6, 7, 11, 18, 25]) {
      add("libraries", "Tests.Libraries.Libraries", method, [n]);
    }
  }

  // tests/Framework.cs: what the compiler imports from the SDK's framework
  // assemblies.
  {
    const framework = (type, method, count) => {
      for (let which = 0; which < count; which++) {
        add("framework", `Tests.Framework.${type}`, method, [which]);
      }
    };
    framework("Collections", "Stacks", 9);
    framework("Collections", "LinkedLists", 7);
    framework("Collections", "SortedSets", 11);
    framework("Collections", "SortedMaps", 10);
    framework("Collections", "PriorityQueues", 7);
    framework("Collections", "OrderedDictionaries", 7);
    framework("Linq", "Selectors", 9);
    framework("Linq", "Casts", 6);
    framework("Linq", "Lists", 9);
    framework("Linq", "Faults", 10);
    framework("Linq", "Groups", 5);
  }

  // tests/Time.cs: dotnet/runtime's TimeSpan, DateTime,
  // DateTimeOffset, Lazy<T> and Stopwatch, and the CoreLib's Guid.
  {
    const time = (method, count) => {
      for (let which = 0; which < count; which++) {
        add("time", "Tests.Time.Time", method, [which]);
      }
    };
    time("Spans", 10);
    time("SpanFormatting", 90);
    time("SpanChecks", 9);
    time("Dates", 12);
    time("DateFormatting", 8 * 22);
    time("Offsets", 8 * 22);
    time("DateChecks", 10);
    time("Guids", 9);
    time("GuidParsing", 10);
    time("Lazies", 8);
    time("Clocks", 7);
  }

  for (const count of [0, 1, 2, 5]) numeric("DoWhile", [count]);
  for (const step of [1, 2, 3, 4, 5]) numeric("StaticCounter", [step]);
  numeric("ForeachNarrowing");

  if (only) {
    for (let index = cases.length - 1; index >= 0; index--) {
      if (!only.includes(cases[index].module)) {
        cases.splice(index, 1);
        inputs.splice(index, 1);
      }
    }
  }

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
        // Checked arithmetic and conversions (tests/Checked.cs), and the
        // checked sums of System.Linq (tests/Linq.cs).
        if (
          test.method.startsWith("Tests.Checked.") ||
          test.method.startsWith("Tests.Linq.")
        ) return 9;
        return test.method.includes(".Abs") ? 9 : 8;
      // Math.Sign of NaN.
      case "ArithmeticException":
        return 8;
      case "ArgumentException":
      case "ArgumentNullException":
        return 10;
      case "SwitchExpressionException":
        return 11;
      case "InvalidCastException":
        return 13;
      case "InvalidOperationException":
        return 14;
      case "KeyNotFoundException":
        return 15;
      case "ArgumentOutOfRangeException":
        return 16;
      // Exceptions without a code of their own, including tests/Exceptions.cs's;
      // BadMove derives from InvalidOperationException.
      case "Exception":
      case "SystemException":
      case "NotSupportedException":
      case "FormatException":
      case "GameException":
      case "FatalError":
      case "StructFault":
      case "FilterError":
        return 17;
      case "BadMove":
        return 14;
      case "TypeInitializationException":
        return 17;
      default:
        throw new Error(`Unmapped CLR exception: ${outcome.Exception}`);
    }
  }

  // The distance in ulps between two f64 encodings (of floats, when
  // `single`), both NaN being none.
  function withinUlps(left, right, ulps, single) {
    if (left === right) return true;
    if (left === "f64:NaN" || right === "f64:NaN") return false;
    function ordinal(encoded) {
      const bits = BigInt("0x" + encoded.slice(4));
      const view = new DataView(new ArrayBuffer(8));
      view.setBigUint64(0, bits);
      let raw;
      if (single) {
        const f = new DataView(new ArrayBuffer(4));
        f.setFloat32(0, view.getFloat64(0));
        raw = BigInt(f.getUint32(0));
        return raw >= 0x80000000n ? 0x80000000n - raw : raw;
      }
      raw = bits;
      return raw >= 0x8000000000000000n ? 0x8000000000000000n - raw : raw;
    }
    const distance = ordinal(left) - ordinal(right);
    return (distance < 0n ? -distance : distance) <= BigInt(ulps);
  }

  let equalValues = 0;
  let equalFaults = 0;
  let policyChecks = 0;
  for (let index = 0; index < cases.length; index++) {
    const test = cases[index];
    const expected = reference[index];
    const exports = instances.get(test.module);
    if (!exports) {
      // Its module did not compile: one failure for all of them.
      continue;
    }

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

      if (test.policy?.ulps !== undefined) {
        // Where neither the CLR's libm nor the runtime's functions promise
        // correct rounding, results may differ by a few ulps of their type.
        assert.equal(expected.Kind, "value", `CLR threw ${expected.Exception}`);
        assert.equal(trapped, false, `Wasm fault=${exports.__fault.value}`);
        const actual = encodeWasmValue(value, expected.Value);
        assert.ok(
          withinUlps(
            actual,
            expected.Value,
            test.policy.ulps,
            test.policy.single,
          ),
          `${actual} is more than ${test.policy.ulps} ulps from ${expected.Value}`,
        );
        equalValues++;
      } else if (test.policy) {
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
      if (!failures.has(`case:${test.method}`)) {
        passed.add(`case:${test.method}`);
      }
    } catch (error) {
      passed.delete(`case:${test.method}`);
      if (!failures.has(`case:${test.method}`)) {
        failures.set(
          `case:${test.method}`,
          `${context}: ${String(error.message).split("\n")[0]}`,
        );
      }
    }
  }

  if (!reportFailures(failures, passed)) {
    throw new Error(
      "Differential checks failed." +
        (keepArtifacts
          ? ` Artifacts: ${output}`
          : " Set GAMEPLAYC_KEEP_ARTIFACTS=1 to keep the artifacts."),
    );
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

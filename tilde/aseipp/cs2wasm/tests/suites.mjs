// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

// Every engine runs the same source modules and behavioral expectations.
import { checkCases, checkGameplay } from "./semantics.mjs";
import {
  checkConstructorAllocationOrder,
  checkConstructors,
} from "./constructors.mjs";
import { checkHeapGameplay } from "./heap-gameplay.mjs";
import { checkSyntax } from "./syntax.mjs";
import {
  checkFieldInitializerAllocationOrder,
  checkFieldInitializers,
} from "./field-initializers.mjs";
import { checkHostImports } from "./host-imports.mjs";
import { checkReentrancy } from "./reentrancy.mjs";
import { checkHostedGameplay } from "./hosted.mjs";
import { checkBreakout } from "./breakout.mjs";
import { checkFeatures } from "./features.mjs";
import { checkInheritance } from "./inheritance.mjs";
import { checkInterfaces } from "./interfaces.mjs";
import { checkDelegates } from "./delegates.mjs";
import { checkGenerics } from "./generics.mjs";
import { checkStructs } from "./structs.mjs";
import { checkCollections } from "./collections.mjs";
import { checkExceptions } from "./exceptions.mjs";
import { checkTypeInitialization } from "./type-initialization.mjs";
import { checkCombinations } from "./combinations.mjs";
import { checkStrings } from "./strings.mjs";
import { checkFilters } from "./filters.mjs";
import { checkMessages } from "./messages.mjs";
import { checkPoisoning } from "./poisoning.mjs";
import { checkUnions } from "./unions.mjs";
import { checkRecords } from "./records.mjs";
import { checkBoxing } from "./boxing.mjs";
import { checkFormatting } from "./formatting.mjs";
import { checkFrames } from "./frames.mjs";
import { checkSimd } from "./simd.mjs";
import { checkNativeIntegers } from "./native-integers.mjs";
import { checkConstructionAllocation } from "./construction.mjs";

export const suites = [
  {
    name: "features",
    source: "tests/Features.cs",
    checkModule: checkFeatures,
  },
  {
    name: "inheritance",
    source: "tests/Inheritance.cs",
    check: checkInheritance,
  },
  {
    name: "interfaces",
    source: "tests/Interfaces.cs",
    check: checkInterfaces,
  },
  {
    name: "delegates",
    source: "tests/Delegates.cs",
    check: checkDelegates,
  },
  {
    name: "generics",
    source: "tests/Generics.cs",
    check: checkGenerics,
  },
  {
    name: "structs",
    source: "tests/Structs.cs",
    check: checkStructs,
  },
  {
    name: "collections",
    source: "tests/Collections.cs",
    check: checkCollections,
  },
  {
    name: "exceptions",
    source: "tests/Exceptions.cs",
    check: checkExceptions,
  },
  {
    name: "type-initialization",
    source: "tests/TypeInitialization.cs",
    check: checkTypeInitialization,
  },
  {
    name: "combinations",
    source: "tests/Combinations.cs",
    check: checkCombinations,
  },
  {
    name: "strings",
    source: "tests/Strings.cs",
    check: checkStrings,
  },
  {
    name: "filters",
    source: "tests/Filters.cs",
    check: checkFilters,
  },
  {
    name: "messages",
    source: "tests/ExceptionMessages.cs",
    check: checkMessages,
  },
  {
    name: "unions",
    source: "tests/Unions.cs",
    check: checkUnions,
  },
  {
    name: "records",
    source: "tests/Records.cs",
    check: checkRecords,
  },
  {
    name: "boxing",
    source: "tests/Boxing.cs",
    check: checkBoxing,
  },
  {
    name: "formatting",
    source: "tests/Formatting.cs",
    check: checkFormatting,
  },
  {
    name: "breakout",
    source: "examples/breakout/Breakout.cs",
    checkModule: checkBreakout,
    poisoning: true,
    // The module's size budget in bytes (behavior.mjs): lower it when the
    // module shrinks, and explain a raise.
    maxBytes: 10_906,
  },
  { name: "syntax", source: "tests/Syntax.cs", check: checkSyntax },
  {
    name: "field-initializers",
    source: "tests/FieldInitializers.cs",
    check: checkFieldInitializers,
  },
  {
    name: "field-initializer-allocation-order",
    source: "tests/FieldInitializers.cs",
    compilerArgs: ["--alloc-units", "16"],
    check: checkFieldInitializerAllocationOrder,
  },
  {
    name: "host-imports",
    source: "tests/HostImports.cs",
    checkModule: checkHostImports,
  },
  {
    name: "reentrancy",
    source: "tests/Reentrancy.cs",
    checkModule: checkReentrancy,
  },
  {
    name: "hosted-gameplay",
    source: "examples/HostedGameplay.cs",
    checkModule: checkHostedGameplay,
    poisoning: true,
  },
  {
    name: "poisoning",
    source: "tests/Poisoning.cs",
    checkModule: checkPoisoning,
    poisoning: true,
  },
  { name: "cases", source: "tests/Cases.cs", check: checkCases },
  { name: "gameplay", source: "examples/Gameplay.cs", check: checkGameplay },
  {
    name: "constructors",
    source: "tests/Constructors.cs",
    check: checkConstructors,
  },
  {
    name: "construction-allocation",
    source: "tests/Construction.cs",
    compilerArgs: ["--alloc-units", "16"],
    check: checkConstructionAllocation,
  },
  {
    name: "constructor-allocation-order",
    source: "tests/Constructors.cs",
    compilerArgs: ["--alloc-units", "16"],
    check: checkConstructorAllocationOrder,
  },
  {
    name: "heap-gameplay",
    source: "examples/HeapGameplay.cs",
    check: checkHeapGameplay,
  },
  {
    name: "frames",
    source: "tests/Frames.cs",
    checkModule: checkFrames,
  },
  // The same, its async methods split by the compiler (--runtime-async).
  {
    name: "frames-runtime-async",
    source: "tests/Frames.cs",
    checkModule: checkFrames,
    compilerArgs: ["--runtime-async"],
  },
  // What .NET leaves to the platform about Vector128 (Wasm SIMD).
  {
    name: "simd",
    source: "tests/SimdPlatform.cs",
    check: checkSimd,
  },
  {
    name: "native-integers",
    source: "tests/NativeIntegers.cs",
    check: checkNativeIntegers,
  },
];

// A module is poisoned by a trap by default (see README.md). The suites
// that go on calling an instance after a trap compile with
// --recover-after-trap; the ones marked `poisoning` run modules as they are
// built by default, re-instantiating after a trap as hosts do.
for (const suite of suites) {
  if (!suite.poisoning) {
    suite.compilerArgs = [
      "--recover-after-trap",
      ...(suite.compilerArgs ?? []),
    ];
  }
}

// The number of checks one suite makes on `module`. A module-level suite
// instantiates the module itself; the rest must import nothing.
export function runSuite(suite, module, assert) {
  if (suite.checkModule) {
    return suite.checkModule(module, assert);
  }
  assert.equal(
    WebAssembly.Module.imports(module).length,
    0,
    `${suite.name}: no imports`,
  );
  return suite.check(new WebAssembly.Instance(module).exports, assert);
}

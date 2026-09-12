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

export const suites = [
  {
    name: "features",
    source: "tests/Features.cs",
    checkModule: checkFeatures,
  },
  {
    name: "breakout",
    source: "examples/breakout/Breakout.cs",
    checkModule: checkBreakout,
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
  },
  { name: "cases", source: "tests/Cases.cs", check: checkCases },
  { name: "gameplay", source: "examples/Gameplay.cs", check: checkGameplay },
  {
    name: "constructors",
    source: "tests/Constructors.cs",
    check: checkConstructors,
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
];

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

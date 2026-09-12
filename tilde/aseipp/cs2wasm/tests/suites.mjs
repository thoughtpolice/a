// Every engine runs the same source modules and behavioral expectations.
import { checkCases, checkGameplay } from './semantics.mjs';
import {
  checkConstructors,
  checkConstructorAllocationOrder,
} from './constructors.mjs';
import { checkHeapGameplay } from './heap-gameplay.mjs';
import { checkSyntax } from './syntax.mjs';
import {
  checkFieldInitializers,
  checkFieldInitializerAllocationOrder,
} from './field-initializers.mjs';
import { checkHostImports } from './host-imports.mjs';
import { checkHostedGameplay } from './hosted.mjs';
import { checkBreakout } from './breakout.mjs';

export const suites = [
  {
    name: 'breakout',
    source: 'examples/breakout/Breakout.cs',
    checkModule: checkBreakout,
  },
  { name: 'syntax', source: 'tests/Syntax.cs', check: checkSyntax },
  {
    name: 'field-initializers',
    source: 'tests/FieldInitializers.cs',
    check: checkFieldInitializers,
  },
  {
    name: 'field-initializer-allocation-order',
    source: 'tests/FieldInitializers.cs',
    compilerArgs: ['--alloc-units', '16'],
    check: checkFieldInitializerAllocationOrder,
  },
  {
    name: 'host-imports',
    source: 'tests/HostImports.cs',
    checkModule: checkHostImports,
  },
  {
    name: 'hosted-gameplay',
    source: 'examples/HostedGameplay.cs',
    checkModule: checkHostedGameplay,
  },
  { name: 'cases', source: 'tests/Cases.cs', check: checkCases },
  { name: 'gameplay', source: 'examples/Gameplay.cs', check: checkGameplay },
  {
    name: 'constructors',
    source: 'tests/Constructors.cs',
    check: checkConstructors,
  },
  {
    name: 'constructor-allocation-order',
    source: 'tests/Constructors.cs',
    compilerArgs: ['--alloc-units', '16'],
    check: checkConstructorAllocationOrder,
  },
  {
    name: 'heap-gameplay',
    source: 'examples/HeapGameplay.cs',
    check: checkHeapGameplay,
  },
];

<!--
SPDX-FileCopyrightText: © 2026 Austin Seipp
SPDX-License-Identifier: Apache-2.0
-->

# gameplayc: C# → WebAssembly GC, packaged with .NET Native AOT

**Validation status: native compiler built and tested on Linux ARM64.**

Direct Native AOT publishing passes with warnings treated as errors, and all
the native compiler/integration assertions pass. The suite runs a copy of only
the executable with SDK and executable search paths disabled, compiles
C# inputs, validates the resulting Wasm, and checks its behavior in Node.js.
With `--all-tools`, the suite also runs independent validation and round-trip
checks, executes exports in Wasmtime, and repeats the full behavioral suite
after Binaryen optimization and in SpiderMonkey. It also compares the same
C# fixtures against actual .NET execution over thousands of inputs.
See [Building with Buck2](#building-with-buck2) for the build.
Windows and Linux x64 publishing have not been validated here. This remains a
prototype with the limits described below.

## Intended deliverable

```
BUILD MACHINE: .NET SDK 11 + Roslyn + native compiler/linker
        |
        | buck2 build -m aot (Roslyn, ILCompiler, linker)
        v
     gameplayc.exe                 [Windows x64 native executable]
          OR
     gameplayc                     [Linux native executable]
        |
        | accepts designer-authored .cs source files
        | embeds Roslyn and its binding reference metadata
        v
     gameplay.wasm                 [Wasm GC, not a .NET runtime in Wasm]
```

The **compiler itself** is the .NET Native AOT program. Its **output** is a Wasm
module. These are different targets. The compiler is designed not to launch
`dotnet`, `csc`, `wat2wasm`, Binaryen, LLVM, or another compiler at run time.
It writes binary `.wasm` directly in C#.

“Standalone” here means one native executable, with no .NET installation,
Roslyn DLLs, reference-pack files, managed apphost sidecars, or Wasm assembler
beside it. It does **not** mean one executable for all OS/CPU combinations, nor
zero OS-library dependencies. Native AOT must be published for each host RID;
a Linux build can still depend on libc and other normal native OS libraries.
Debug symbols are optional deployment files, not execution dependencies.

## Pinned toolchain

- .NET SDK `11.0.100-rc.1.26425.128`, pinned by hash in
  `buck/toolchains/csharp/BUILD` together with the matching ILCompiler and
  NativeAOT runtime packages.
- Compiler framework `net11.0`; compiler source language C# 14.
- Roslyn `Microsoft.CodeAnalysis.CSharp` `5.9.0`.
- Embedded binding metadata from the SDK-resolved
  `Microsoft.NETCore.App.Ref` targeting pack's `ref/net11.0/System.Runtime.dll`.
- Wasm output uses the GC/reference features in core 3.0. The **binary header
  version is still 1**, not 3. No blanket support for every Wasm 3.0 feature
  or every engine implementing some Wasm 3.0 features is claimed.

Buck2 downloads the pinned SDK; nothing needs installing. An SDK change is a
change to that BUILD file, followed by the native and semantic tests here.
The embedded reference assembly comes from the same SDK's targeting pack.
The compiler's `--info` reports whether dynamic code is supported in its running
process. The acceptance suite requires `native-aot=True`.

## Building with Buck2

The compiler is a `csharp.binary` in `BUILD`; the toolchain under
`buck/toolchains/csharp` downloads the pinned SDK and compiler packages, so
nothing needs installing. From anywhere in the repository:

```sh
buck2 run tilde//aseipp/cs2wasm:gameplayc -- --info
buck2 run tilde//aseipp/cs2wasm:gameplayc -- -o publish/gameplay.wasm examples/Gameplay.cs
```

This runs the compiler JIT-compiled on the pinned runtime; `-m release`
builds it optimized. `:gameplayc-native` is the same compiler as a single
Native AOT executable, which the isolated acceptance suite needs.

The tests run under Buck2 as well; Deno executes the Node-flavoured scripts:

```sh
buck2 test tilde//aseipp/cs2wasm:                   # everything below
buck2 test tilde//aseipp/cs2wasm:behavior-test      # every suite and rejection case
buck2 test tilde//aseipp/cs2wasm:differential-test  # the same C# on the CLR and in Wasm
buck2 test tilde//aseipp/cs2wasm:encoding-test      # hand-assembled probes
buck2 test tilde//aseipp/cs2wasm:integration-test   # native compiler, isolated, plus --binaryen
```

`tests/behavior.mjs` and `tests/differential.mjs` take the compiler as a
command line, so the JIT layout's `dotnet exec gameplayc.dll` works as well as
a single native executable; only a single executable is copied and run in
isolation.

`tests/integration.mjs` takes a Native AOT compiler executable and adds
`--all-tools` to exercise every tool supplied by the development shell:

```sh
deno run --allow-all tests/integration.mjs "$GAMEPLAYC" --all-tools
```

Individual options are also available:

| Option | Checks |
| --- | --- |
| `--wasm-tools` | Validate and round-trip the binary/text formats; execute GC examples in Wasmtime. |
| `--binaryen` | Validate and optimize with `wasm-opt -O2`; rerun all behavior checks on the optimized modules. |
| `--spidermonkey` | Rerun all behavior checks in Mozilla's `js140` shell, including traps and state reset. |
| `--differential` | Run the same C# on the CLR, then compare thousands of seeded inputs, numeric edge cases, and faults with Wasm. |

With both Binaryen and SpiderMonkey enabled, SpiderMonkey checks the original
and optimized modules. The behavior checks and SpiderMonkey use
`tests/suites.mjs` to run the same cases and expected results. The compiler
still runs in isolation without SDK files or external tools on its executable
search path. The differential oracle is a separate `:reference` program; see
[tests/reference/README.md](tests/reference/README.md).

For a game host that retains entity state across frames and commits commands
only after successful execution:

```sh
./examples/run-hosted.sh
```

See [docs/HOSTING.md](docs/HOSTING.md) for the typed import interface and
transactional example host.

For a complete playable game, follow [the Breakout walkthrough](examples/breakout/README.md).
It includes C# physics and collisions, heap allocation, typed host calls, browser
input and rendering, a local server, and a deterministic terminal run:

```sh
"$GAMEPLAYC" -o publish/breakout.wasm examples/breakout/Breakout.cs
node examples/breakout/run.mjs
node examples/breakout/serve.mjs
```

The toolchain carries SDK and compiler packages for Linux (x64, arm64) and
macOS (arm64); the target is the machine running the build. Windows Native
AOT is not wired up, and no Windows or Linux x64 build has been validated here.

Do not substitute `typeof(object).Assembly.Location` for the embedded
metadata resource. The deployed Native AOT executable does not have a CoreLib
DLL at that location. The reference assembly is embedded as **data**, and
supplied to Roslyn through `MetadataReference.CreateFromImage`; it is not
loaded into an AssemblyLoadContext.

## Inspecting the generated Wasm

For a runnable C# → Wasm → Wasmtime example, run `./examples/run-wasmtime.sh`;
it builds the compiler through Buck2 unless `GAMEPLAYC` names one. See [examples/README.md](examples/README.md)
for the source behavior and expected results.

The development shell includes `wasm-tools`, Wasmtime, WABT, Binaryen 132, and
SpiderMonkey 140.14.0. Use `wasm-tools` to validate and disassemble the
compiler's GC output:

```sh
"$GAMEPLAYC" -o publish/gameplay.wasm examples/Gameplay.cs
wasm-tools validate publish/gameplay.wasm
wasm-tools print publish/gameplay.wasm -o publish/gameplay.wat
wasmtime run --invoke Demo.Gameplay.SumSquares publish/gameplay.wasm 5
# 30
deno run --allow-all tests/integration.mjs "$GAMEPLAYC" --wasm-tools
```

WABT 1.0.41's `wasm2wat` rejects this module with `unexpected type form (got
0x4e)` at offset `0x0c`; `--enable-all` still fails (displaying `-0x32`). This is
a WABT limitation: `0x4e` encodes a GC recursive type group, which its
[type-section reader does not support](https://github.com/WebAssembly/wabt/blob/1.0.41/src/binary-reader.cc).
The compiler uses that encoding to support forward and recursive heap references.
The same output validates and round-trips through `wasm-tools` 1.258.0 and runs
in Wasmtime 48.0.1 and Node.js. Wasmtime's CLI currently prints experimental
`--invoke` notices when passing arguments or returning values.

[Binaryen](https://github.com/WebAssembly/binaryen) provides another binary
reader and validator, plus optimization passes. Its `wasm-dis` also handles
this GC output:

```sh
wasm-dis publish/gameplay.wasm -o publish/gameplay-binaryen.wat
wasm-opt publish/gameplay.wasm --enable-gc --enable-reference-types \
  --enable-nontrapping-float-to-int --enable-sign-ext -O2 \
  -o publish/gameplay.optimized.wasm
```

Besides GC, the output uses the sign-extension and non-trapping
float-to-integer instructions, both part of core 2.0.

[SpiderMonkey](https://spidermonkey.dev/) is Mozilla's JavaScript/WebAssembly
engine. Running the same tests there adds an engine implementation independent
of Node/V8 and Wasmtime.

## Compiler pipeline and deliberate scope change

```
C# source
  → Roslyn parsing, binding and diagnostics
  → declaration/type policy
  → typed IOperation tree
  → structured Wasm instructions + GC heap types
  → binary .wasm
```

This first implementation **does not import arbitrary CIL DLLs** and does not
reuse the earlier IL verifier. It goes directly from Roslyn's typed operations
to Wasm, preserving the structured source control flow. This removes the need
for a CIL stack verifier, CFG importer, SSA converter, and structurizer from the
first implementation. A future CIL importer can target a shared lowering layer,
but that importer is not present here. This is also not a complete optimizing
compiler: it uses locals and straightforward code generation.

All source method bodies are visited, not only reachable exports. Unsupported
operations cause compilation failure; there is no interpreter/JIT/.NET fallback.
The module then contains only what its exports and static initialization
reach: an unreferenced method is dropped, and so is an unreferenced host
import, so a host has to supply the capabilities a module calls, not every
one its bindings declare.

## Exports

A public static method of a public class (every enclosing class public) is
exported under its full name, such as `Demo.Gameplay.SumSquares`, when its
parameters and result are scalars. Everything else stays internal to the
module: methods of `internal` classes, non-public methods, and methods that
take or return references. Two exports with one name are rejected.

`[Gameplay.WasmExport("frame")]` exports a static scalar-signature method under
exactly that name instead, which is how a module implements a WIT world's
exports. Public classes are therefore the module's API surface; helpers
belong in `internal` classes, the C# default for top-level declarations.

## WIT worlds

The boundary need not be declared by hand. `witgen` generates the imports,
exports and types of a WIT world as C#, with the canonical ABI's names, and
wraps the compiled module into a component whose conformance to the world
wit-component checks; see [docs/WIT.md](docs/WIT.md). The macros in
[defs.bzl](defs.bzl) do this in Buck, and
[examples/console](examples/console/README.md) is Breakout written against
the console SDK's `game` world that way:

```sh
buck2 test tilde//aseipp/cs2wasm/examples/console:run-test
buck2 run tilde//aseipp/cs2wasm/examples/console:serve
```

The declarations gameplay code binds against (`WasmImportAttribute`,
`WasmExportAttribute`) live in [sdk/Gameplay.cs](sdk/Gameplay.cs). The
compiler embeds and supplies that file itself; add it to an ordinary .NET
project to edit gameplay code with IDE support.

## Implemented source paths

Types: `bool`, `sbyte`, `byte`, `short`, `ushort`, `int`, `uint`, `long`,
`ulong`, `char`, `float`, `double`, `void`; enums over any integer type,
including `[Flags]` enums; nullable Wasm references for sealed source classes,
which may be nested and `partial`; single-dimensional and jagged arrays of
supported elements. Narrow integers are held sign- or zero-extended in an
i32 and wrap back to their width after every operation that could leave it.

Members: mutable and `readonly` instance fields with initializers; static
fields (Wasm globals) with initializers and static constructors; properties,
automatic (a field access, no call) or with accessor bodies, including the
`field` keyword, `init` accessors and property initializers; implicit and
explicit instance constructors with positional/named arguments and `: this(...)`
chaining; `partial` methods; typed host imports through `WasmImport`; explicit
export names through `WasmExport`.

Statements and expressions: locals and constants; assignments to locals,
parameters, fields, static fields, properties and array elements, with `_ =`
discards; compound assignments and increments for every numeric type, with
single evaluation of the location; integer and floating arithmetic (floating
remainder excepted), bit operations and shifts, signed and unsigned;
comparisons; short-circuit Booleans; conditionals and `??` between
references; `if`, `while`, `do/while`, `for`, array `foreach`, `switch`
statements with constant, relational, `and`/`or`/`not` and `when` cases,
`switch` expressions, `is` patterns, `break`, `continue`, `return`; direct
static/instance calls and recursion; source-ordered evaluation of named
arguments; object and array initializers.

Conversions follow unchecked C#: implicit and explicit numeric conversions
between all scalar types, enum conversions, integer narrowing by wrapping,
and floating-point to integer conversion that saturates to the target's range
with NaN becoming zero, as .NET 9 and later define. Checked arithmetic and
conversions, and user-defined conversions, are rejected rather than guessed.
Faulting integer division and remainder are checked explicitly (both use the
throwing overflow behavior for `MinValue / -1` and `MinValue % -1`). CLR
exceptions are not implemented: faulting operations use the trap policy below.

Framework methods with a direct Wasm lowering are compiled inline, and nothing
else from the framework is callable: `Math`/`MathF` `Abs`, `Sqrt`, `Floor`,
`Ceiling`, `Truncate`, `Round` (half to even), `Min`, `Max`, `Clamp`,
`CopySign`; `float`/`double` `IsNaN`, `IsInfinity`, `IsFinite`;
`BitOperations` `PopCount`, `LeadingZeroCount`, `TrailingZeroCount`,
`RotateLeft`, `RotateRight`. The tests compare each against the CLR.

Missing/rejected features include other BCL calls and native calls, unsafe
code, managed byrefs, `Span<T>`, user-defined structs, strings, boxing,
nullable value types, interfaces/inheritance, generics, explicit base
initializers, indexers/events/operators, `goto` (including `goto case`),
declaration and type patterns, non-array `foreach`, delegates/lambdas,
async/iterators, reflection, dynamic, exception handling, transcendental
math, and source-generator/analyzer plug-ins. What the compiler does not
support it reports with a source location and never approximates.

### Static state

Static fields are module globals, so state persists across exported entries
on one instance; a host that wants a fresh script instantiates the module
again. Each class's static field initializers run in declaration order, then its
static constructor, class by class in source order, during the first exported entry, on
that entry's budget. If they fault, the flag recording their completion stays
clear and the next entry runs them again from the start, so a host that
retries never observes half-initialized state. This differs from the CLR,
which initializes each type on first use and never retries. An entry made
while initialization is still running (a host import calling back into an
export) faults with code 12 instead of observing it half done.

## GC representation

Sealed source objects become Wasm GC structs. Arrays become Wasm GC arrays,
not offsets into a linear-memory heap. Heap types occupy a recursive type group,
so self-referential fields and forward type references are representable.
The compiler emits `struct.new_default`, `struct.get`, `struct.set`,
`array.new_default`, `array.get`, `array.set`, `array.len`, nullable typed
references, and reference equality. There are no Wasm memory/table/data sections
and no embedded .NET runtime in the generated modules. Explicitly annotated host
methods become typed function imports; other modules remain import-free.

No exact native object layout is exposed. Every reference is treated as nullable
at the Wasm level, even when C# annotations suggest otherwise; the emitter checks
null and bounds before accesses. This avoids relying on nullable annotations as
a runtime guarantee. Public exported signatures are primitive-only in version 0.1.

## Runtime budgets and fault ABI

Each exported wrapper saves the module-global execution context, resets it,
calls its internal implementation and restores it on return, so an export
re-entered from a host import neither spends nor refills its caller's budgets.
Internal calls bypass wrappers, so recursion cannot reset its own budget; depth
across host re-entry is bounded only by the engine's stack. Defaults are:

| Budget | Default | Meaning |
|---|---:|---|
| Control-step fuel | 100,000 | One unit per method entry and loop header, NOT instructions or nanoseconds |
| Active call depth | 64 | Logical call-depth check |
| Allocation units | 1,048,576 | Monotonic logical charge: 16 + 8×fields/elements; NOT actual heap bytes |
| Maximum array length | 65,536 | Per allocation; negative lengths are rejected |

CLI overrides are `--fuel`, `--depth`, `--alloc-units`, `--max-array`.

Before a compiler-inserted fault, global `__fault` is set and `unreachable` traps.
The host catches the runtime's trap result and reads `__fault`. It is reset on
the next entry.

| Code | Fault | CLR counterpart |
|---:|---|---|
| 1 | Control-step fuel exhausted | none |
| 2 | Call depth exceeded | `StackOverflowException` |
| 3 | Allocation charge exhausted | none |
| 4 | Array length negative or above the maximum | `OverflowException` |
| 5 | Null reference | `NullReferenceException` |
| 6 | Array index out of range | `IndexOutOfRangeException` |
| 7 | Integer division by zero | `DivideByZeroException` |
| 8 | Signed division/remainder overflow | `OverflowException` |
| 9 | `Math.Abs` of the minimum value | `OverflowException` |
| 10 | `Math.Clamp` with minimum above maximum | `ArgumentException` |
| 11 | `switch` expression with no matching arm | `SwitchExpressionException` |
| 12 | Entry while static initialization is running | none (the CLR lets the same thread see partial state) |

A VM trap not produced by these checks can leave `__fault` at zero; the host
must classify it as a generic runtime fault, not success.

For a simple test host after a successful compiler build:

```js
import fs from 'node:fs';
const { instance } = await WebAssembly.instantiate(
  fs.readFileSync('publish/gameplay.wasm'), {});
console.log(instance.exports['Demo.Gameplay.SumSquares'](5)); // 30
console.log(instance.exports['Demo.Gameplay.VectorLengthSquared'](2, 3, 6)); // 49
try {
  instance.exports['Demo.Gameplay.LoopForever']();
} catch (error) {
  if (!(error instanceof WebAssembly.RuntimeError)) throw error;
  console.log('gameplay fault', instance.exports.__fault.value); // 1
}
```

The sum and vector results are covered by the compiler integration tests, which pass
with the Linux ARM64 Native AOT executable.

## Security and engine integration limits

This is **not a production sandbox and not a proof that gameplay cannot crash a
game**. It has no Capcom RE Engine integration or verified RE ABI. No private
engine implementation details are assumed.

The embedding must validate every module with a real Wasm validator, enforce an
import/feature policy, provide trusted resource controls, catch traps, and decide
how to discard or disable a faulty script. The compiler does not include an
independent Wasm validator. A handwritten emitter can produce invalid binaries;
the host must reject them rather than trust the compiler.

Compiler-inserted budgets are useful for trusted compiler output, but are **not
a security boundary against arbitrary/tampered Wasm**, which could omit or
modify those checks. Use VM-enforced metering/interruptions, verify/reinstrument
modules independently, or authenticate a trusted compiler pipeline. Include
module-size/compilation-time limits and a suitable maximum native Wasm stack.

Logical allocation charging is not a real GC-heap quota. It cannot account for
engine object overhead, collector work, transient live memory, retained objects,
other modules, or physical process OOM. An engine with suitable heap limits and
allocation-failure handling is still required. Per-entry quotas are not global
quotas across all scripts. Use per-store/instance isolation as appropriate.

Host imports let compiled code request changes to engine state. The example
host validates integer handles and finite coordinates, refuses reentrant entry,
and queues commands until the export returns successfully. A trap alone does
not roll back arbitrary host side effects: each embedding must implement that
policy and bound host-call cost. Native host bugs are not made safe merely by
calling them from Wasm. Process isolation remains a stronger boundary when
process survival must include containment of VM/native-host failures.

## Files

- `src/Gameplay.Compiler`: compiler frontend (`Frontend*.cs`: declarations,
  the module boundary, emission), lowering (`FunctionEmitter*.cs`: shell,
  numerics, control flow, intrinsics), binary writer and CLI.
- `sdk/Gameplay.cs`: the attribute declarations, embedded in the compiler and
  meant for IDE projects.
- `witgen/`: the WIT bindings generator and componentizer (Rust); `defs.bzl`:
  the Buck macros; `tests/wit`: the world exercising every binding construct.
- `examples/console`: Breakout against the console SDK's `game` world, with a
  headless and a browser host.
- `tests/Features.cs`, `tests/features.mjs`: statics, enums, switches,
  patterns, properties, partial classes, export naming, wide numerics.
- `tests/behavior.mjs`: every suite and rejection case on any compiler command.
- `examples/Gameplay.cs`: GC vector and integer array example.
- `examples/HeapGameplay.cs`: particle simulation, cyclic graph, maze search, and allocation pressure.
- `tests/Cases.cs`, `tests/integration.mjs`: native, SDK-less, end-to-end acceptance suite.
- `tests/semantics.mjs`: shared behavior checks for original and optimized Wasm.
- `tests/Constructors.cs`, `tests/constructors.mjs`: construction order and resource-limit cases.
- `tests/suites.mjs`: common module list for Node, SpiderMonkey, and Binaryen checks.
- `tests/differential.mjs`, `tests/reference`: actual CLR-versus-Wasm execution comparisons
  (`:reference` is the CLR oracle).
- `examples/HostedGameplay.cs`, `examples/game-host.mjs`: typed host imports and persistent frame state.
- `tests/spidermonkey.mjs`: adapter for the Mozilla shell.
- `tests/rejections.mjs`: unsupported-source fixtures.
- `tests/encoding.mjs`: independently hand-assembled Wasm probes (actually run here).
- `BUILD`: the Buck2 targets and tests.

## References

Official specifications/documentation used while preparing the prototype:

- .NET 11 SDK download and full version:
  https://dotnet.microsoft.com/en-us/download/dotnet/11.0
- Native AOT deployment and limitations:
  https://learn.microsoft.com/en-us/dotnet/core/deploying/native-aot/
- Roslyn package:
  https://www.nuget.org/packages/Microsoft.CodeAnalysis.CSharp/5.9.0
- Native-AOT Roslyn/analyzer-loading discussion:
  https://github.com/dotnet/runtime/issues/83355
- Wasm 3.0 completion:
  https://webassembly.org/news/2025-09-17-wasm-3.0/
- Binary type and instruction encodings:
  https://webassembly.github.io/spec/core/binary/types.html
  https://webassembly.github.io/spec/core/binary/instructions.html

Third-party packages and embedded reference metadata retain their upstream
licenses. Preserve the .NET/Roslyn notices applicable to the actual dependencies
when distributing a published binary.

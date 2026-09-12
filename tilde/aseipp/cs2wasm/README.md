<!--
SPDX-FileCopyrightText: © 2026 Austin Seipp
SPDX-License-Identifier: Apache-2.0
-->

# gameplayc: C# → WebAssembly GC

**Validation status: built and tested on Linux ARM64.**

The compiler runs JIT-compiled on the pinned .NET runtime and builds with
warnings treated as errors. Its tests compile C# inputs, validate the
resulting Wasm and check its behavior, repeat every behavioral suite after
Binaryen optimization, and compare the same C# fixtures against actual .NET
execution over thousands of inputs. With `--all-tools`, the integration suite
also runs independent validation and round-trip checks, executes exports in
Wasmtime, and repeats the behavioral suite in SpiderMonkey.
See [Building with Buck2](#building-with-buck2) for the build.
Windows and Linux x64 have not been validated here. This remains a
prototype with the limits described below.

## Intended deliverable

```
BUILD MACHINE: the pinned .NET SDK 11, which Buck2 downloads
        |
        | buck2 run tilde//aseipp/cs2wasm:gameplayc (Roslyn, on the JIT)
        v
     gameplayc                     [a .NET program on the pinned runtime]
        |
        | accepts designer-authored .cs source files
        | embeds its binding reference metadata and the gameplay CoreLib
        v
     gameplay.wasm                 [Wasm GC, not a .NET runtime in Wasm]
```

The **compiler itself** is a .NET program, run JIT-compiled. Its **output** is
a Wasm module. These are different targets. The compiler is designed not to
launch `dotnet`, `csc`, `wat2wasm`, Binaryen, LLVM, or another compiler at run
time. It writes binary `.wasm` directly in C#.

It runs on the pinned .NET runtime with Roslyn's assemblies beside it, and
needs no SDK, reference-pack files or Wasm assembler: the reference metadata
gameplay code compiles against is embedded. On Linux the runtime's hashing,
which Roslyn uses on every compile, loads the system's OpenSSL
(`libssl.so.3` and `libcrypto.so.3`).

## Pinned toolchain

- .NET SDK `11.0.100-rc.1.26425.128`, pinned by hash in
  `buck/toolchains/csharp/BUILD`.
- Compiler framework `net11.0`; compiler source language C# 14; gameplay
  code is parsed as C# 15.
- Roslyn `Microsoft.CodeAnalysis.CSharp` `5.11.0-1.26425.128`, the build in the
  .NET 11 RC1 SDK, from the dotnet-tools feed (see
  `buck/third-party/csharp/nuget.toml`).
- Embedded reference assemblies from the SDK-resolved
  `Microsoft.NETCore.App.Ref` targeting pack's `ref/net11.0` (System.Runtime
  and the others gameplay code compiles against), and the SDK's own
  System.Collections and System.Linq.
- Wasm output uses the GC/reference features in core 3.0. The **binary header
  version is still 1**, not 3. No blanket support for every Wasm 3.0 feature
  or every engine implementing some Wasm 3.0 features is claimed.

Buck2 downloads the pinned SDK; nothing needs installing. An SDK change is a
change to that BUILD file, followed by the native and semantic tests here.
The embedded reference assemblies come from the same SDK's targeting pack.

## Building with Buck2

The compiler is a `csharp.binary` in `BUILD`; the toolchain under
`buck/toolchains/csharp` downloads the pinned SDK and compiler packages, so
nothing needs installing. From anywhere in the repository:

```sh
buck2 run tilde//aseipp/cs2wasm:gameplayc -- --info
buck2 run tilde//aseipp/cs2wasm:gameplayc -- -o publish/gameplay.wasm examples/Gameplay.cs
```

This runs the compiler JIT-compiled on the pinned runtime; `-m release`
builds it optimized. The commands below name the compiler as `$GAMEPLAYC`:

```sh
GAMEPLAYC="buck2 run tilde//aseipp/cs2wasm:gameplayc --"
```

The tests run under Buck2 as well; Deno executes the Node-flavoured scripts:

```sh
buck2 test tilde//aseipp/cs2wasm:                   # everything below
buck2 test tilde//aseipp/cs2wasm:behavior-test      # every suite and rejection case
buck2 test tilde//aseipp/cs2wasm:differential-test  # the same C# on the CLR and in Wasm
buck2 test tilde//aseipp/cs2wasm:encoding-test      # hand-assembled probes
buck2 test tilde//aseipp/cs2wasm:integration-test   # every suite, then again after wasm-opt
```

`tests/behavior.mjs`, `tests/differential.mjs` and `tests/integration.mjs`
take the compiler as a command line, such as the JIT layout's `dotnet exec
gameplayc.dll` that Buck2's `$(exe)` gives them. `tests/integration.mjs` takes
its options first; `--all-tools` exercises every tool supplied by the
development shell:

```sh
deno run --allow-all tests/integration.mjs --all-tools $GAMEPLAYC
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
`tests/suites.mjs` to run the same cases and expected results. The
differential oracle is a separate `:reference` program; see
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
$GAMEPLAYC -o publish/breakout.wasm examples/breakout/Breakout.cs
node examples/breakout/run.mjs
node examples/breakout/serve.mjs
```

For a bigger one, [Lichgate](examples/lichgate/README.md) is a twin-stick
roguelite on the console SDK (seeded floors, creatures and a three-phase
boss scripted with `async`, relics, particles, a synthesizer and saved high
scores), built on [Kiln](engine/README.md), an entity-component-system
engine compiled once as a gameplay library, whose source generator writes
each game's schedule from its attributes:

```sh
buck2 run tilde//aseipp/cs2wasm/examples/lichgate:lichgate-web-serve
```

The toolchain carries the SDK for Linux (x64, arm64) and macOS (arm64); no
Windows or Linux x64 build has been validated here.

Do not substitute `typeof(object).Assembly.Location` for the embedded
metadata resource: that is the running runtime's implementation CoreLib, not
the reference assembly gameplay code compiles against. The reference
assembly is embedded as **data**, and
supplied to Roslyn through `MetadataReference.CreateFromImage`; it is not
loaded into an AssemblyLoadContext.

## Inspecting the generated Wasm

For a runnable C# → Wasm → Wasmtime example, run `./examples/run-wasmtime.sh`;
it builds the compiler through Buck2 unless `GAMEPLAYC` names a compiler command. See [examples/README.md](examples/README.md)
for the source behavior and expected results.

The development shell includes `wasm-tools`, Wasmtime, WABT, Binaryen 132, and
SpiderMonkey 140.14.0. Use `wasm-tools` to validate and disassemble the
compiler's GC output:

```sh
$GAMEPLAYC -o publish/gameplay.wasm examples/Gameplay.cs
wasm-tools validate publish/gameplay.wasm
wasm-tools print publish/gameplay.wasm -o publish/gameplay.wat
wasmtime run --invoke Demo.Gameplay.SumSquares publish/gameplay.wasm 5
# 30
deno run --allow-all tests/integration.mjs --wasm-tools $GAMEPLAYC
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
  --enable-nontrapping-float-to-int --enable-sign-ext --enable-multivalue \
  --enable-exception-handling -O2 -o publish/gameplay.optimized.wasm
```

Besides GC, the output uses the sign-extension and non-trapping
float-to-integer instructions and multiple function results (for structs),
all part of core 2.0, and a module with a `try` statement uses exception
handling as core 3.0 encodes it (`try_table`, `throw`, `throw_ref`,
`exnref`; not the legacy `try`/`catch`/`delegate`), which V8 (Node, Deno),
SpiderMonkey 140, Wasmtime 48, wasm-tools and Binaryen 132 accept.

[SpiderMonkey](https://spidermonkey.dev/) is Mozilla's JavaScript/WebAssembly
engine. Running the same tests there adds an engine implementation independent
of Node/V8 and Wasmtime.

## Compiler pipeline and deliberate scope change

```
C# source
  → Roslyn: parsing, binding, diagnostics, IL
      (against .NET's reference assemblies)
  → the IL read back over the gameplay CoreLib and the SDK's
    framework assemblies (System.Collections, System.Linq)
  → API and type policy
  → structured Wasm instructions + GC heap types
  → binary .wasm
```

The compiler is a CIL importer ([docs/IMPORTER.md](docs/IMPORTER.md)): the
sources are compiled by Roslyn against .NET's own reference assemblies, so
their API surface is .NET's, and their IL (typed, structured, its byrefs
made places, boxes and cells) is lowered to Wasm over the gameplay CoreLib
(`corelib/`): the runtime layer built by `csc` as a core library, with
.NET's declarations of the framework types it does not define itself,
generated from dotnet/runtime's reference sources, and under the SDK's own
framework assemblies above it (System.Collections, System.Linq), whose IL
it imports as the user's. This is not a complete optimizing compiler: the
lowering is straightforward and keeps every value in a local, and a pass
over the finished code keeps on the Wasm stack what can stay there and
packs the locals that remain (docs/IMPORTER.md, "Stackification as
built").

It replaced the first frontend, which lowered Roslyn's typed operations
(IOperation) directly (docs/IMPORTER.md, "Retiring the IOperation
frontend"). Beyond what that frontend compiled, it compiles variance:
variant interfaces and delegates, and array covariance, whose stores of the
wrong type throw `ArrayTypeMismatchException` (docs/IMPORTER.md, "Variance
as built"). Generic instantiations over reference types share one body
where more than one of them runs it (value-type instantiations stay
monomorphized), and a module is pruned as the closed world it is: arrays it
never converts to another type need nothing arrays of unknown type do, and
type tests of what it never makes are folded, with the code only they led
to (docs/IMPORTER.md, "Shared generics as built" and "Closed-world
pruning"). And it compiles `async` methods: C#'s state machines over the
CoreLib's task library, run by a frame loop the module's frame export
advances (`await Frames.NextFrame()`, `Task.Delay` in game time;
docs/IMPORTER.md, "Async as built"). With `--runtime-async` (and
`runtime_async = True` in `gameplay_module`), csc compiles them as
runtime-async methods (`MethodImplAttributes.Async`) instead, which the
compiler splits into resumable functions over a frame of their locals:
smaller modules than the state machines' (docs/IMPORTER.md, "Runtime-async
methods as built").

It compiles SIMD too: `System.Runtime.Intrinsics.Vector128<T>` is
Wasm's `v128`, its members SIMD instructions, and System.Numerics'
`Vector2`, `Vector3`, `Vector4`, `Quaternion`, `Plane`, `Matrix3x2` and
`Matrix4x4` are dotnet/runtime's own, on it (docs/IMPORTER.md, "SIMD as
built", which lists where Wasm's results and the CLR's may differ).

And System.Numerics' `BigInteger`, `Complex` and `Complex<T>`:
dotnet/runtime's arithmetic, compiled into the CoreLib with a few patched
lines, and the CoreLib's own formatting and parsing for the invariant
culture (docs/IMPORTER.md, "System.Runtime.Numerics as built"). Native
integers (`nint`, `nuint`) are 64-bit values.

For the compiler's own debugging, it reads a few environment variables:
`GAMEPLAYC_TRACE` (a stack trace with an error, and the function an internal
error was in), `GAMEPLAYC_STATS` (instantiation, function
and type counts, once per compilation of the module: `instantiations` counts
them as shared, one per canonical form, `exact` one per exact instantiation;
`all` lists the instantiations, `functions` each kept function's size and
the kept vtables), `GAMEPLAYC_DUMP_IL` (the folded IL of the functions whose
names contain it), `GAMEPLAYC_DUMP_REFERENCES=DIR` (the member references of
each imported assembly, as `corelib/framework/*.txt` lists them),
`GAMEPLAYC_DUMP_GENERATED=DIR` (the sources each source generator wrote,
under DIR/<generator>), `GAMEPLAYC_SHARING=0` (every instantiation monomorphized),
`GAMEPLAYC_CLOSED_WORLD=0` (one compilation, no type tests folded),
`GAMEPLAYC_STACKIFY=0` (every value in a local, as the lowering leaves it;
`GAMEPLAYC_DEBUG_STACKIFY` names the bodies the pass leaves alone),
`GAMEPLAYC_DEBUG_SHARING` (each method's sharing decision and its sites),
`GAMEPLAYC_DEBUG_ESCAPES=1` (where each array escapes, and each type
test the world folds) and `GAMEPLAYC_TIMINGS=1` (the milliseconds each
phase of each compilation of the module took, and why it compiled again).

Unsupported code causes compilation failure; there is no interpreter/JIT/.NET
fallback. A call of what nothing implements says what it calls and why:
`'System.Math.Asinh(double)' is unsupported: .NET declares it, but the
gameplay CoreLib does not implement it.` (the CoreLib declares .NET's whole
surface, and implements a part of it), a member of an assembly the
compiler does not import, or an extern method without `WasmImport`; a
generic-math member a type argument implements only as .NET's declaration
names that implementation. The module contains only what its exports and static initialization
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
buck2 test tilde//aseipp/cs2wasm/examples/console:steer-test
buck2 run tilde//aseipp/cs2wasm/examples/console:breakout-console-web-serve
```

Strings, lists, tuples, options, records, and variants and results (as C# 15
unions) cross the boundary too: the generated glue copies them through a
linear memory the module gets only when it uses them, as the canonical ABI
requires. WASI 0.3's async functions do as well, as `Task`s,
through the component model's callback ABI (docs/WIT.md, "Async
functions"), with their futures and streams as the CoreLib's
`FutureReader<T>`, `StreamReader<T>` and their writers (docs/WIT.md,
"Futures and streams"). wlink links such components into one core module
with its own async runtime, whose host interface `tests/wit-linked.mjs`
drives, and the console takes them as `async-game`s, whose one long task
waits for frames through the SDK's scheduler
([examples/console](examples/console/README.md), "Fireworks as an async
game"); component runtimes such as Wasmtime run them as they are.

The declarations gameplay code binds against (`WasmImportAttribute`,
`WasmExportAttribute`, and the glue's `CanonicalAbiAttribute`) live in
[sdk/Gameplay.cs](sdk/Gameplay.cs). The
compiler embeds and supplies that file itself; add it to an ordinary .NET
project to edit gameplay code with IDE support.

## Source generators

`--generator PATH` (repeatable; `generators = [...]` in `gameplay.module`)
runs the Roslyn source generators an assembly declares over the sources
before they are compiled, as csc runs the generators of its `/analyzer:`
references: the same discovery (`[Generator]` classes implementing
`IIncrementalGenerator` or `ISourceGenerator`, found through Roslyn's
`AnalyzerFileReference`), the same `CSharpGeneratorDriver`, and the
generated trees compiled with the sources as C# 15. What a generator
reports is the compilation's: its errors fail it with the compiler's own,
located in the sources (`Misuse.cs(15,15): error PROBE001: ...`), and its
warnings are written to standard error while the compilation goes on. A
generator that throws fails the compilation; csc would only warn (CS8785)
and go on without its output.

A generator learns about the build the way MSBuild tells generators a
project's `CompilerVisibleProperty` items: as global analyzer config
options named `build_property.<Name>`
(`AnalyzerConfigOptionsProvider.GlobalOptions`). gameplayc gives every
generator two, for a module's compilation and a library's alike:

| Option | Value |
| --- | --- |
| `build_property.GameplayOutputKind` | `library` under `--library`, `module` otherwise |
| `build_property.GameplayAssemblyName` | the assembly's name (`Gameplay` for a module) |

A module and a library are both compiled as a DLL, so the compilation's
`OutputKind` cannot tell them apart; a generator that writes something
different for each (Kiln's writes a library its declarations' members and
a module its schedule) reads `GameplayOutputKind`:

```csharp
var kind = context.AnalyzerConfigOptionsProvider.Select(static (options, _) =>
    options.GlobalOptions.TryGetValue("build_property.GameplayOutputKind", out var value) ? value : null);
```

csc has no such option unless a global analyzer config (`/analyzerconfig:`)
or MSBuild supplies it, so a generator that also runs as csc's analyzer
needs a fallback when it is absent (Kiln's decides by `OutputKind`: a
`library` target is a library, an `exe` a program).

A generator is an ordinary `csharp.library` compiled against
`third-party//csharp:Microsoft.CodeAnalysis.CSharp`, the Roslyn the
compiler embeds, which its references resolve to when the compiler loads
it; the same assembly is csc's analyzer in a `csharp.binary` (the CLR
side of a test), since the SDK's csc is the same Roslyn build:

```python
depot.csharp.library(
    name = "my-generator",
    srcs = ["MyGenerator.cs"],
    deps = ["third-party//csharp:Microsoft.CodeAnalysis.CSharp"],
)

gameplay.module(name = "game", srcs = ["Game.cs"], generators = [":my-generator"])
```

`:generator-test` builds `tests/generator/DescribeGenerator.cs`, compiles
`Probe.cs` with it by gameplayc and by csc and compares the two, checks
that an error, a warning and an exception of the generator surface, and
that it is told `library` compiling `Kinds.cs` with `--library` and
`module` compiling `Built.cs` over it.
[Kiln](engine/README.md)'s is a larger one: an entity-component-system's
schedule (its components' storage, query loops and system order),
generated from the attributes of a game and of the Kiln libraries it
references, whose metadata the generator reads.

## Libraries

`gameplayc --library Name -o Name.dll sources...` compiles C# into a
gameplay library: an assembly (and its portable PDB beside it) compiled
exactly as a module's sources are, against the same reference assemblies,
language version and options, with `--generator`s of its own. It is then
checked as a module's code is (every member it references against
`corelib/allowlist.txt`, located in its sources), so a library that
compiles is one any module can use. `--reference PATH` (repeatable; an
assembly or a directory of them) makes a module's sources, or another
library's, compile against libraries; a module's Wasm includes the
libraries' IL as its own code (docs/IMPORTER.md, "Libraries"): the same
closed world, pruning and shared generics as if their sources were the
module's, so a module is as large as one compiled from all the sources.
In Buck:

```python
gameplay.library(name = "geometry", srcs = ["Geometry.cs"], assembly_name = "Geometry")
gameplay.library(name = "shapes", srcs = ["Shapes.cs"], deps = [":geometry"])
gameplay.module(name = "game", srcs = ["Game.cs"], deps = [":shapes"])
```

A `library` target is a directory of its assembly and those of its `deps`,
so a module names only the libraries it uses directly.

- **Only the module's sources export and import.** A library's public
  static methods are not exports, and `WasmImport`, `WasmExport` and
  witgen's bindings are the module's alone: the SDK's attributes are not
  supplied to a library's compilation.
- **Names.** A library's name (letters, digits, `.`, `_`, `-`) must not be
  `Gameplay` (every module's assembly name), nor `System`, `Microsoft` or
  `Gameplay` dotted names; an assembly that is not a library (keyed, or
  not an assembly) is refused as a reference. Two references of one name
  must be the same assembly.
- **Internals.** A module sees a library's public types and members;
  `[assembly: InternalsVisibleTo("Gameplay")]` in a library shows it its
  internals too.
- **Generators run where they are named.** A library's `generators` see
  its own sources; a generator that writes code from a game's declarations
  (Kiln's) runs on the module, where it sees the libraries' types through
  their metadata. What it generates must then be the module's: a partial
  type cannot span a library and a module. Kiln's world is a library for
  that reason, and its generator writes each program a schedule class
  instead of the other half of the world (engine/README.md).
- **Budgets are the module's.** `--fuel` and the other budgets are refused
  with `--library`.

`tests/libraries/` holds two libraries, Shapes over Geometry, built by
`gameplay.library` (`:test-shapes`), and `tests/Libraries.cs` the module
over them that the differential test compares with the CLR: classes derived
across both boundaries, a library's interface implemented, re-implemented
and given a default member, its generics instantiated with the module's
types (shared and not), its static constructors, iterators, closures,
events, async methods and exception filters, and its internals through
`InternalsVisibleTo`. `tests/behavior.mjs` checks a library's refused call
(located in its sources), that its methods are not exported, that its
internals are its own, and the names and references refused.

## Implemented language and library

Types: `bool`, `sbyte`, `byte`, `short`, `ushort`, `int`, `uint`, `long`,
`ulong`, `char`, `float`, `double`, `void`; enums over any integer type,
including `[Flags]` enums; nullable Wasm references for source classes
(sealed, non-sealed or abstract, deriving from object, from a class of the
program or from a framework class that is not sealed here: the CoreLib's
`List<T>`, `Dictionary`, `HashSet<T>`, `Queue<T>` and `Random` are), source interfaces, and `Action`, `Func` and source delegate types;
classes may be nested and `partial`; source structs, `readonly` or not (see
[Structs](#structs)); records and record structs (see [Records](#records));
`object`, holding any of these, value types boxed (see
[Objects and boxing](#objects-and-boxing)); single-dimensional, jagged and
multidimensional (see [Multidimensional arrays](#multidimensional-arrays))
arrays of supported
elements; generic source classes, structs, interfaces and delegate types,
instantiated over any of these (see [Generics](#generics)). Narrow integers
are held sign- or zero-extended in an i32 and wrap back to their width after
every operation that could leave it.

Members: mutable and `readonly` instance fields with initializers; static
fields (Wasm globals) with initializers and static constructors; properties,
automatic (a field access, no call) or with accessor bodies, including the
`field` keyword, `init` accessors and property initializers; implicit and
explicit instance constructors with positional/named arguments, `: this(...)`
chaining and `: base(...)`; primary constructors of classes, structs and
records; overrides of `ToString`, `Equals` and `GetHashCode` in classes and
structs; virtual, abstract, override, `sealed override`
and `new` methods and properties, and `base.` member access; covariant
return overrides of methods and properties (the function returns the
slot's type, and callers cast it back); interfaces
with methods and properties, interface inheritance, and implicit or explicit
implementations; default interface members (an itable holds a default body
itself, whose `this` is the interface value), explicit overrides of them
in derived interfaces, private and static interface members, static fields
and static constructors (initialized as a class's are); static abstract and
virtual interface members, methods, properties and operators, which a call
constrained to a type argument runs as that type implements them (or as the
virtual member's default body); generic virtual, abstract and override
methods and generic interface methods, whose instantiations each have a
dispatcher testing the receiver against every class (and box) that can
receive it, most derived first, since vtables have no slots for them;
`partial` methods; generic methods, static and instance,
and generic local functions; constraints (`class`, `struct`, base class,
interface, `new()`), `default(T)`, `new T()`, and comparisons of type
parameters with `null`; `ref` and `out` parameters, including `out var` and
`out _`; user-defined operators and conversions, including `true` and
`false`, which `if` and a user-defined `&&` (`false(a) ? a : a & b`) and
`||` (`true(a) ? a : a | b`) use; exception classes deriving from `System.Exception` or the BCL
exceptions (see [Exceptions](#exceptions)); typed host imports through
`WasmImport`; explicit export names through `WasmExport`; attribute
classes of the program's own (generic ones too), applied wherever C#
allows, which are metadata for the compiler and source generators and
never values, so code that makes one is rejected.

Statements and expressions: locals and constants; assignments to locals,
parameters, fields, static fields, properties and array elements, with `_ =`
discards; compound assignments and increments for every numeric type, with
single evaluation of the location; integer and floating arithmetic (floating
remainder exactly as the CLR's `fmod`), bit operations and shifts, signed and unsigned;
comparisons; short-circuit Booleans; conditionals and `??` between
references; `?.` on references, including `?.Invoke`; `if`, `while`,
`do/while`, `for`, `foreach` over arrays, strings and anything with
`GetEnumerator`, `MoveNext` and `Current` (a disposable enumerator disposed
however the loop ends); `IEnumerable<T>`, `IEnumerator<T>`, the non-generic
`IEnumerator` and `IDisposable` as interfaces of classes, which arrays,
strings (`IEnumerable<char>`) and the collections (with `Keys` and
`Values`) are converted to as in the CLR, their enumerators resetting as the
CLR's do; iterators (`yield return` and `yield break`) in methods and
accessors of classes and structs (whose iterators run on a copy of the
struct, made when called, as C# makes one), generic, virtual and nested ones
included, and in local functions (keeping the variables they capture), returning `IEnumerable<T>` or `IEnumerator<T>`: each enumeration
runs the body afresh, suspended at each `yield return` with its locals kept,
anywhere in loops, switches (with `goto case` too), statement lists with
labels and `goto`, `using`, `lock` and `try`/`finally` statements, whose finally
blocks run when the loop leaves early or the enumerator is disposed, as
C#'s do (Reset throws `NotSupportedException`); `using` statements and declarations over class, struct and
interface resources implementing `IDisposable` (disposed last first in finally
blocks, a null one skipped); `lock`, which checks its object for null (a
module is single-threaded, so there is nothing to wait for); `new
object()`; `switch`
statements with constant, relational, `and`/`or`/`not`, type
(`case Circle c:`) and `when` cases, `switch` expressions, `is` patterns,
positional, property and extended property patterns (`Point(var x, _)`,
`{ X: > 0 }`, `{ A.X: 1 }`) with designations, positional patterns on
tuples (`(a, b) switch { (1, _) => ... }`), list patterns with slices
(`[1, .. var rest, > 0]`) on arrays, strings and anything with a `Length`
or `Count` and an int indexer (and a `Slice` for a slice with a
subpattern), `var` and declaration
patterns of a value's own type, deconstruction into variables, `with`,
indices and ranges (`a[^1]`, `a[1..^2]`, `s[..3]`, `list[^i] += 1`,
`System.Index` and `System.Range` values and their members, which
runtime/Ranges.cs supplies): an array sliced by a range is a copy, as
`RuntimeHelpers.GetSubArray` makes; anything else is indexed through its
length and int indexer and sliced through its `Slice` (`Substring` for a
string), with C#'s evaluation order and its shortcut for `^i` and int
indices, which never build an `Index` (so a negative one is out of range
rather than an invalid `Index`);
`break`, `continue`, `return`; `goto` to any label C# allows, `goto case`
and `goto default` (branches of the IL like any other; a goto into a loop,
which makes control flow irreducible, is lowered as a loop dispatching on
the block to run, spending fuel as a loop iteration);
`throw` (statements, expressions and
`throw;`), and `try` with `catch` clauses (typed, with variables and `when`
filters) and `finally`; direct, virtual and interface calls and recursion;
source-ordered evaluation of named arguments; `params` arrays, optional
parameters (the defaults the call's static target declares), `in`
parameters, which are values here (a mutating call on one runs on a copy,
as C# makes one), and `ref readonly` parameters, which are references; indexers; object, collection
and array initializers, including nested member initializers
(`Origin = { X = 1 }` initializes a struct field in place, `Items = { 1, 2 }`
adds to the member's collection); collection expressions (`[a, ..b, c]`) as
arrays (`[]` is `Array.Empty`'s), `List<T>` (made at its count, so its
capacity is the count, and made from a lone spread as a collection, whose
null throws `ArgumentNullException`) and any collection with a
parameterless constructor and `Add`, with spreads of arrays, strings and
anything with a `Count` and an int indexer, evaluated in C#'s order.
Reference conversions follow the
CLR: upcasts to a base class or interface are free, and downcasts, `as` and
`is T`/`is T t` test the dynamic type. Lambdas, anonymous methods, local
functions and method groups (static, instance, virtual, interface,
`base.`, and a struct's, over the box C# makes of the value) become
delegates, `System.Object`'s virtual members' too (`Func<string> f =
x.ToString`, `Func<object, bool> g = x.Equals`, `x.GetHashCode`, of a
class, a struct or scalar boxed, an interface or a type parameter), which
run the target's override as `ldvirtftn` finds it (a null target throws
`NullReferenceException` where the group is made); captured variables are shared with the code that
declares them, and a `foreach` variable or loop-body local is a fresh
variable in every iteration, as in C#.

Conversions follow C#: implicit and explicit numeric conversions between
all scalar types, enum conversions, integer narrowing by wrapping, and
floating-point to integer conversion that saturates to the target's range
with NaN becoming zero, as .NET 9 and later define. In a checked context
(`checked(...)`, `checked { }`, including lambdas and local functions
written inside one), integer `+`, `-`, `*`, unary `-`, `++`, `--` and
compound assignments (whose conversion back to a narrow target is checked
whatever the operator, as the CLR's is), their lifted forms, and explicit
conversions between integers and from floating point to an integer
(failing for NaN and for values whose truncation does not fit) fault with 9
where the CLR throws `OverflowException`; user-defined `checked` operators
are called there. A user-defined conversion must take and produce exactly
the types it converts between.
Faulting integer division and remainder are checked explicitly (both use the
throwing overflow behavior for `MinValue / -1` and `MinValue % -1`). Every
check the CLR would throw from throws the same exception when the module
handles exceptions, and faults with the fault ABI below otherwise.

What a module calls of the framework is IL: the gameplay CoreLib's and the
SDK's framework assemblies' (see [Compiler pipeline](#compiler-pipeline-and-deliberate-scope-change)),
included where code calls it. Members with a direct Wasm lowering are
instructions instead: `Math`/`MathF` `Abs`, `Sqrt`, `Floor`,
`Ceiling`, `Truncate`, `Round` (half to even), `Min`, `Max`, `Clamp`,
`CopySign`; `float`/`double` `IsNaN`, `IsInfinity`, `IsFinite`;
`BitOperations` `PopCount`, `LeadingZeroCount`, `TrailingZeroCount`,
`RotateLeft`, `RotateRight`. The tests compare each against the CLR.
The rest of `Math` and `MathF` is the CoreLib's C# (`runtime/Math.cs`,
`corelib/Math.cs`): `Sin`, `Cos`,
`Tan`, `Asin`, `Acos`, `Atan`, `Atan2`, `Sinh`, `Cosh`, `Tanh`, `Exp`,
`Log` (with a base), `Log10`, `Log2`, `Pow`, `Cbrt` and `ScaleB`, with C99's
special values as .NET has them. Each sums its series' leading terms in
double-double arithmetic after an exact argument reduction (Cody-Waite,
then Payne-Hanek past 1647099 for the trigonometric functions), so a
result is within about 0.52 ulps and costs 8 to 75 units of fuel. The
CLR's come from glibc: `tests/Transcendentals.cs` checks them against
each other within an ulp (two for `Cbrt`, `Sinh`, `Cosh` and `Tanh`,
where glibc's own error reaches two) over special values, boundaries
and random arguments. `Round` to a number of digits and with a
`MidpointRounding` is .NET 11's: the exact value rounded at the digit,
then the nearest float to that decimal (so `Math.Round(2.675, 2)` is
2.67, not the 2.68 scaling by 100 would give). `Sign` throws
`ArithmeticException` for NaN. `IEEERemainder` and `BigMul` are .NET's,
and `FusedMultiplyAdd` rounds once (docs/IMPORTER.md, "SIMD as built");
the hyperbolic inverses (`Asinh`, `Acosh`, `Atanh`) remain unsupported
(`decimal`'s overloads are [decimal](#decimal)'s). The
numeric types' generic math statics are C# as .NET implements them
(runtime/Shims.cs): for every integer type `Abs`, `Max`, `Min`, `Clamp`,
`Sign`, `IsNegative`, `IsPositive`, `IsEvenInteger`, `IsOddInteger`,
`IsPow2`, `Log2`, `PopCount`, `LeadingZeroCount`, `TrailingZeroCount`,
`RotateLeft`, `RotateRight`, `DivRem` and, signed, `CopySign`,
`MaxMagnitude` and `MinMagnitude`; for `float` and `double` those of
`Math` and `MathF` and `IsNegative`, `IsPositive`, `IsInteger`,
`IsEvenInteger`, `IsOddInteger`, `IsNormal`, `IsSubnormal`,
`IsNegativeInfinity`, `IsPositiveInfinity`, `MaxMagnitude`,
`MinMagnitude`, `MaxNumber`, `MinNumber` and `Lerp`; and the scalars'
`Equals(T)`, `Equals(object)` and `CompareTo(T)`. `System.HashCode`
(runtime/Hashing.cs) is .NET's xxHash32, `Combine` and `Add` alike, seeded
with zero where the CLR seeds it at random per process. `System.Enum`'s generic
`Parse`, `TryParse` (with or without `ignoreCase`), `GetNames`, `GetValues`,
`GetName` and `IsDefined` are .NET's (runtime/Enums.cs): names and
comma-separated flag combinations, numbers in the underlying type's range
(`OverflowException` past it), surrounding whitespace, over the names and
values the compiler gives each enum in value order. The
collections are the CoreLib's and the SDK's (see
[Collections](#collections)).

Missing/rejected features include BCL members outside the gameplay
CoreLib, the imported framework assemblies and the API rules
(`corelib/allowlist.txt`; docs/IMPORTER.md, "API control"), native calls,
unsafe code (pointers and `stackalloc` outside a span), pinning memory
(`Memory<T>.Pin`, `MemoryHandle`, `MemoryManager<T>`), the object members
other than those listed under [Objects and boxing](#objects-and-boxing)
(`MemberwiseClone`), reflection beyond the `System.Type` members listed
there, `base.ToString()` of `System.Object`, tests of objects for delegate
types, `System.Delegate` as a type (so
`GetInvocationList`, `Method`, `Target` and `DynamicInvoke`),
`System.Nullable`'s static helpers, source `ref struct`s, tuples of more
than seven elements, `System.Threading.Lock`, members of
`System.Exception` other than `Message`, `InnerException`, `ToString` and
`GetBaseException` (`StackTrace`,
`Data`), overriding `Message`, `Vector<T>`, `Vector256<T>` and
`Vector512<T>` (see docs/IMPORTER.md, "SIMD as built"), multithreading, dynamic, the
`Math` members listed above as unsupported, and analyzer plug-ins (source
generators run, see [Source generators](#source-generators)). What the
compiler does not support it reports with a location
and never approximates.

### Unions

C# 15 unions are what C# compiles them to: `union Pet(Cat, Dog)` is a
struct holding its case value as an object in its `Value` field, a
value-type case boxed (see [Objects and boxing](#objects-and-boxing)), and
the default union's `Value` is null. A case value converts to the union
(implicitly, or through `new Pet(cat)`), and a type pattern, declaration
pattern or `switch` over the cases (with `when` guards, `not`, and `null`
for the default union) tests the value's type, unboxing a value-type case,
as C# lowers it; a property pattern then tests the case's members. A switch
expression no case of which matches the default union throws
`SwitchExpressionException`, as in the CLR. Unions compare and hash as
structs, their `ToString` is the one C# generates, and they may be generic,
declare members, and have cases of any type, `object` and delegate types
included, though testing a value for a delegate type is unsupported (see
[Objects and boxing](#objects-and-boxing)). C# 15 `closed` classes need
nothing of their own: they are abstract classes whose switches the
compiler knows to be exhaustive.

### Objects and boxing

An `object` holds any reference, or a boxed value: converting a scalar, an
enum, a struct, a record struct or a union to `object`, to an interface it
implements, or to a union case, boxes it, a new box each time, charged to
the allocation budget like an object of the value's fields (a struct's
storage and the box). Unboxing (`(int)o`, `(Point)shape`) copies the value
out, faulting with `NullReferenceException` for null and
`InvalidCastException` for a box of another type (but for an enum and its
underlying integer, as the CLR's unbox allows). `is`, `as`, casts, type
and declaration patterns (`o is int i`, `case Point { X: 1 } p`) and
switches test an object's type exactly. An interface call on a boxed struct
runs the struct's method on the box's storage, so a mutating call mutates
the box, as in the CLR. `Equals(object)`, `GetHashCode()` and `ToString()`
work on any object: a class's overrides (records' included), a struct's,
or `ValueType`'s field-by-field equality and hash and its type's name;
scalars by value, strings by contents; other classes by identity, printing
their type's full name; arrays by identity. `object.ReferenceEquals` and
the static `object.Equals` work too, as do objects as `Dictionary` keys and
`HashSet` elements, `List<object>`, string concatenation and interpolation of
objects, and these members on type parameters (`left.Equals(right)` in
generic code). A class prints its type's CLR name
(`Ns.Box`1[System.Int32]`), an array `System.Int32[]`, an exception
`Type: message` and its inner exception's text, as the CLR's
`Exception.ToString` does (an `AggregateException` each of its inner
exceptions' after it, as its override does), without the stack trace a
thrown one has in the CLR, which is not kept (the text is the CLR's with
its lines of frames taken out), and a delegate its type's
name. `GetBaseException` is the CLR's: the innermost inner exception, and
an `AggregateException`'s through aggregates of one exception. Delegates
compare as the CLR's do (see below). An array hashes by its
length and a delegate by its type and method: consistent with equality,
while the CLR's identity-based values vary from run to run.

`typeof(T)` and `GetType()` give one `System.Type` object per type
(runtime/Types.cs), made on first use, so `==` and `Equals` compare
identities as the CLR's runtime types do; its `Name`, `Namespace`,
`ToString()`, `FullName` (which throws `NotSupportedException` for a
generic instantiation, whose CLR name spells out assemblies a module has
none of), `BaseType`, `IsValueType`, `IsClass`, `IsInterface`, `IsEnum`,
`IsArray`, `IsPrimitive`, `IsSealed`, `IsAbstract` and `IsGenericType` are
the CLR's. `GetType()` on a value whose static type fixes its class (a value
type, a sealed class, a string, an array) is its static type's object;
otherwise a helper tests the object against every class, box, array type
and string of the module, most derived first, or, for a value of a class
of the module's or an exception class, against the classes deriving from
it alone, so an exception's `GetType()` costs the exceptions' type
objects rather than every class's.

### Records

Records and record structs work positional (a primary constructor whose
parameters become `init` properties, or `set` ones in a mutable record
struct) or nominal, and the members C# synthesizes for them do what the CLR's
do. Value equality (`Equals(R)`, `==`, `!=`) compares the runtime types, so
a derived record never equals its base, then every instance field the record
declares, as `EqualityComparer<T>.Default` would: strings by content, floats
by `Equals` (NaN equals NaN), records by their own equality, other classes
and arrays by identity. `GetHashCode` is consistent with it, though not the
CLR's value (which hashes a `Type`), so records serve as `Dictionary` keys and
`HashSet` elements, which enumerate in insertion order as in the CLR. `with`
clones through `<Clone>$` and the copy constructor (a declared one runs),
then assigns; on a struct, record or not, it copies the value. `ToString`
prints `Name { X = 1, Y = 2 }`: the public fields and readable properties,
base members first, through the virtual PrintMembers (so `base.ToString()`
in a derived record prints the derived members, as in the CLR), each member
formatted as `ToString` does (see [Strings](#strings)); a null record member
prints nothing. A declared `ToString`, `Equals(R)`, `GetHashCode` or copy
constructor replaces the synthesized one. Records may be abstract, sealed,
generic and nested, derive from records passing `base` positional arguments,
and implement interfaces, a positional property implementing an interface
property. Deconstruction (`var (x, y) = p`, nested) and positional patterns
use `Deconstruct`; a record's synthesized one reads the properties without
a call.

The members C# synthesizes are its IL, so a record prints through
`StringBuilder` and `PrintMembers` as C# lowers it. A synthesized member gets
a function only when code needs it (a call, or an equality, hash or print
that reaches it), but for the ones a vtable slot holds, so records passed
around as data cost their fields and vtables alone. Interface and object
values compare and hash as `EqualityComparer<T>.Default` does, through
`Equals(object)` and `GetHashCode`, so a record behind one compares by
value.

Classes and structs take primary constructors too: their parameters are read
by field and property initializers and the base constructor call. A class's
parameter that a member uses (a method, an accessor, a lambda) is kept in
a hidden field, as C# keeps it, assigned before the initializers run, and
every use of it is of that field, in a class or a struct.

### Structs

A struct is a value, so copying it copies every field, and C# copies on
assignment, argument passing and return, into and out of array elements
and fields, and into closures. The compiler keeps two forms:

- **Flattened**, wherever a struct is a value: in Wasm locals, parameters and
  results. Its fields' scalars and references (nested structs expanded in
  place) take one Wasm value each, so a function returning a struct has
  several results, and a copy is a copy of those values. Nothing is
  allocated.
- **Boxed**, wherever a struct is storage the program can reach: a field of a
  class, an array element, a static field, a captured variable. The box is
  a mutable GC struct of the fields, whose nested structs have boxes of their
  own. The storage owns its box, allocated with it (with the object, the
  array's elements when the array is created, the environment, or a global's
  initializer); storing a struct writes its values into the box, and reading
  one reads them out, so no two variables ever share a box.

A struct's instance members, its constructors included, receive the box of
the storage they run on, as the CLR passes a managed pointer:
`holder.Position.Move(1, 2)` and `points[i].Move(1, 2)` change the
object's field and the array's element in place, and a callee that faults
or throws midway has already changed it. A local or parameter whose address
is taken (a member called on it, a `ref` or `out` argument) lives in a box
(a one-field cell for anything but a struct) for the whole call, allocated
on entry, so it too is mutated in place. Where C# only mutates a copy (a
`readonly` field outside its constructors, `this` in a `readonly` member,
or the result of a call), its IL makes the copy, in a local of its own.
`default(S)` and `new S()` without a constructor are the zero value.
A local or parameter passed as an `in` argument of a method of the module
is not boxed for it: the callee takes an `in` parameter as its value, so
the reference is read at once, and a function passing its locals `in`
allocates nothing (`ref readonly` parameters, which may be used as
addresses, as `Unsafe.Add` does, take a reference, and so a box).

A managed reference (a `ref` or `out` argument, a ref local, a ref
return, `ref readonly` ones included) to a struct is the box of its storage,
which every struct in the heap has. One to anything else is a `$ref` of its
type: the cell of a variable (a local or parameter code takes a reference to
lives in one for the whole call, and a captured one in a cell its
environment holds), or a handle naming storage without a cell, an array
element (the array and index) or a field (the object, or none for a static
field, and the field's number among the fields of its type references are
taken to), so the reference aliases the storage itself: writes through it
are the storage's at once, two references to one element alias each other,
and taking one checks a null receiver or an index as the CLR's does. A type
whose references include handles reads and writes them through its load
and store functions, which tell a cell from a handle; otherwise a `$ref` is
a cell. Ref locals may be reassigned (`r = ref other`); ref-returning
methods, virtual ones included, properties and indexers work as values,
assignment targets, and references passed on. A reference to an `in`
parameter, which is a value here, is rejected. As in the CLR, a nested
field or element store (`holder.Position.X = F()`, `points[i].X = F()`)
checks the receiver and index before evaluating the right-hand side.

Boxes a function allocates for its boxed locals, copies and temporaries are
charged to the allocation budget like objects of that many fields; a struct
field of an object, or a struct element of an array, adds its fields to the
container's charge.

Making a struct allocates nothing when its constructor only stores its
arguments and constants in its fields (tuples, `KeyValuePair`, positional
record structs, most hand-written ones), or assigns `this` a static
factory's value (System.Numerics' `Vector2(x, y) { this = Create(x, y); }`):
`new S(...)` and C#'s construction into a variable (`S s = new(...)`, which
is a constructor call on the variable) make the value in place from the
arguments, or call the factory, without the box and without the
constructor's call (src/Gameplay.Compiler/Frontend.Construction.cs). Other
constructors run on a box as above, and so does any constructor of a
struct with a static constructor, whose run initializes the type. A local
whose address only reaches such a construction, a field access, or a call
of an automatic property's getter (read in place) is a value, not a box,
too. `tests/Construction.cs` checks each shape against the CLR, and, in
the behavior suite, that loops of a thousand of them fit an allocation
budget of 16 units.

### Tuples

C#'s tuples are the runtime's `ValueTuple` structs (`runtime/Tuples.cs`,
two to seven elements), so they are values like any struct: flattened in
locals, boxed in fields, arrays and collections, generic arguments and
dictionary keys. Element names are only names, `(int X, int Y)` being the
same type as `(int, int)`. A tuple literal converts each element to its
field's type in order; a tuple converts to another element by element.
Deconstruction (`var (a, b) = t`, `(a, b) = (b, a)`, nested ones, and in
`foreach`) evaluates the targets' receivers and indices, then the value,
then assigns left to right with each element's conversion, into variables,
parameters, fields, properties, array elements and discards. `==` and `!=`
evaluate both sides, then compare element by element with each pair's own
`==` (numbers after C#'s promotion, strings by content, references by
identity, `null` literals), so a NaN element is unequal to itself; `Equals`
is `EqualityComparer<T>.Default`'s, under which it is equal. `ToString`
gives `(1, x)` as the CLR does. `GetHashCode` combines the elements'
hashes deterministically: the CLR's `HashCode.Combine` is seeded at random
per process, so the numbers differ from any one CLR run while equal tuples
still hash equally.

### decimal

`decimal` is the runtime's `Decimal` struct (`runtime/Decimal.cs`), which
the compiler stands in for `System.Decimal` as it does the runtime's
`Index` for `System.Index`: the CLR's fields (flags holding the sign and
the scale 0-28, the high 32 bits and the low 64 bits of the 96-bit
integer), flattened like any struct into an i32, an i32 and an i64. Its
arithmetic is .NET 11's `DecCalc` ported statement for statement (its
stack buffers are arrays): `+`, `-`, `*`, `/` and `%` give the CLR's
exact results and scales (trailing zeros kept, 28-digit quotients,
products scaled down with round-half-even and sticky bits) and throw its
`OverflowException` and `DivideByZeroException`, with its messages.
Literals and constants (`const decimal`, `decimal.MaxValue`) are their
fields' constants, `-0m` the zero Roslyn makes of it. C#'s built-in
decimal operators and conversions, which Roslyn binds without an operator
method, are the struct's operator methods: the numeric conversions both
ways (to an integer throwing when out of range, checked or not), `++`,
`--`, compound assignment, lifted operators and conversions of `decimal?`,
constant, relational and `switch` patterns, and tuple `==`. Conversions
from `double` and `float` are .NET 11's exact ones (the value's exact
decimal expansion rounded once to 28 places or 96 bits, so `(decimal)1.23`
is `1.2299999999999999822364316060`), and to them the correctly rounded
quotient (Clinger's fast path as .NET takes it). Equality and hashing are
by value (`1.0m == 1.00m`, with .NET's `GetHashCode`, which unscales), in
`Equals`, `EqualityComparer<T>`, dictionaries, sets and records; order is
`CompareTo` (`IComparable<decimal>`). The members are .NET's: the
constructors (`int[]` bits and `(lo, mid, hi, isNegative, scale)`
included), `Scale`, `Add` through `Remainder`, `Negate`, `Compare`,
`Equals`, `Round` (with digits and a `MidpointRounding`), `Floor`,
`Ceiling`, `Truncate`, `Abs`, `Min`, `Max`, `Sign`, `Clamp`, `CopySign`,
`MaxMagnitude`, `MinMagnitude`, `IsInteger` and the other predicates,
`GetBits`, `ToInt32` and the other conversions, `FromOACurrency` and
`ToOACurrency`, and `Math`'s decimal overloads. `ToString` with no format,
`G` and `R` print every digit of the scale (`1.50`), never in scientific
notation; the standard (`F`, `N`, `E`, `C`, `P`, `G5`) and custom formats
round half away from zero as the CLR's do, in string interpolation too
(`{price:F2}`); `D` and `X` throw `FormatException`. `Parse` and
`TryParse` read `NumberStyles.Number` with the invariant culture (white
space, a leading or trailing sign, a point, thousands separators; no
exponent), rounding past 29 digits half to even. LINQ's `Sum`, `Average`,
`Min` and `Max` over decimals are the CoreLib's, with .NET's results (the
SDK's are generic math, below). The `IFormatProvider`,
`NumberStyles` and span overloads of `ToString`, `TryFormat`, `Parse` and
`TryParse` are too, with every `NumberStyles` flag .NET allows for decimal
(exponents, parentheses, the invariant currency symbol `¤`) and its
`ArgumentException` for the others, and so is .NET 11's `TryParsePartial`
(the number a text starts with, and how many characters it takes); the provider is the invariant culture
(see [Cultures](#cultures)). An enum converts to and from decimal
explicitly, as its underlying type does. Generic math (a type parameter
constrained to `INumber<T>` or another `System.Numerics` interface) is
supported over every numeric type: the integer types, `char`, `float`,
`double` and decimal (`tests/GenericMath.cs`; decimal's are .NET's
Decimal.cs members, `runtime/DecimalMath.cs`, checked in
`tests/Decimals.cs`), and `nint`, `nuint`, `Int128`, `UInt128` and `Half`,
with the conversions between every pair of them (`CreateChecked`,
`CreateSaturating`, `CreateTruncating`) and the interfaces' default members
as .NET's are (docs/IMPORTER.md, "Generic math as built";
`tests/WideMath.cs`). `tests/Decimals.cs` checks decimal against the CLR
over tens of thousands of values of every shape.

`Int128` and `UInt128` are dotnet/runtime's structs of two `ulong`s, with
their text: `ToString` and `TryFormat` in every standard and custom format
(hexadecimal and binary of the 128 bits), and `Parse`, `TryParse` and
`TryParsePartial` with any integer `NumberStyles`, as .NET's
`TryParseBinaryInteger` reads them (`corelib/Int128.cs`). `Half` is
dotnet/runtime's struct of its 16 bits: its arithmetic (through `float`, as
.NET's is), conversions, `BitConverter` members and generic math, its
shortest round-trip text and the standard and custom formats, and its
parsing with any `NumberStyles` but `HexFloat` (which throws
`NotSupportedException`), correctly rounded from all the digits
(`corelib/Half.cs`). The floating-point `X` format of .NET 11 (hexadecimal
floating point, `0x1.8p+1`, with a precision rounded to even) is .NET's for
`Half`, `float` and `double` (and so `Complex`'s parts); parsing it
(`NumberStyles.HexFloat`) is not supported.

### Cultures

`IFormatProvider`, `CultureInfo` and `NumberFormatInfo` are the runtime's
classes of the invariant culture (`runtime/Culture.cs`), the one the CLR
oracle and every formatting and parsing member here use:
`CultureInfo.InvariantCulture`, `NumberFormatInfo.InvariantInfo`,
`CultureInfo.NumberFormat` and a null provider are what the provider
overloads (decimal's for now) take. Other cultures, `CurrentCulture`
(the machine's) and the culture constructors are rejected where code names
them.

### Convert

`System.Convert`'s conversions between `bool`, `char`, the integer types,
`float`, `double`, `decimal` and `string` are .NET's (`runtime/Convert.cs`,
generated from rules read off .NET 11's `Convert.cs`): integers checked,
with `Convert`'s `OverflowException` messages; `double` to an `int` or
`uint` rounded to even, to a `long` or `ulong` by `Math.Round` and a
checked conversion; `decimal` rounded to even; strings parsed with the
invariant culture (null is zero or false, and throws for `char`, which
needs exactly one character); and the `InvalidCastException` between
`char` and `bool`, `float`, `double` and `decimal`. `tests/Converts.cs`
compares every pair with the CLR. The `object`, `IFormatProvider`, base
and `DateTime` overloads are not supported.

### Spans

`Span<T>` and `ReadOnlySpan<T>` are the runtime's structs of those names
(`runtime/Spans.cs`), as a tuple type is its `ValueTuple`: an array, a start
and a length, flattened like any struct (Roslyn enforces the ref-struct
rules). C#'s span conversions (an array, a span or a collection expression
to a span, a string to a `ReadOnlySpan<char>`, `params ReadOnlySpan<T>`)
make them; a span of a string's chars views a copy of them (strings are
immutable, so nothing can tell). `stackalloc T[n]` (and with an
initializer) made a span is a fresh array (a negative size is an
`OverflowException`, where the CLR's process dies). Their members are
.NET's: the indexer (a reference, so `span[i] = x`, `ref var r =
ref span[i]` and `span[i].Field = x` write the array), `Length`, `IsEmpty`,
`Empty`, `Slice`, ranges and `^i`, `CopyTo` (overlapping as `memmove`),
`TryCopyTo`, `Fill`, `Clear`, `ToArray`, `ToString` (a char span's text,
else `System.Span<Int32>[n]`), `==`, and `foreach`, by reference too;
`MemoryExtensions`' `AsSpan`, `SequenceEqual`, `IndexOf`, `LastIndexOf`,
`Contains`, `StartsWith`, `EndsWith`, `Reverse`, `Sort`, `BinarySearch`,
`Trim` and `Equals`/`StartsWith` with a `StringComparison`; `new
string(span)`, `string.Concat` of spans, and
`CollectionsMarshal.AsSpan(list)`, a view of the list's array.

### Memory

`Memory<T>` and `ReadOnlyMemory<T>` are the runtime's structs of those
names (`runtime/Memory.cs`), standing in for the framework's as the span
types do: an array, its owner, a start and a length. Unlike spans they are
ordinary structs, so fields, array elements, collections, closures and
boxes hold them. An array converts to either, and `Memory<T>` to
`ReadOnlyMemory<T>`; `AsMemory` makes them of an array (with a start, a
length, an `Index` or a `Range`) or of a string, whose memory views a copy
of its chars but remembers the string, so two memories of a string are
equal as the CLR's are. Their members are .NET's: `Length`, `IsEmpty`,
`Empty`, `Slice` and ranges, `Span` (a span of the same array, so writes
reach it), `ToArray`, `CopyTo`, `TryCopyTo`, `Equals` (the same owner,
start and length) and `ToString` (a char memory's text, else
`System.Memory<Int32>[n]`), with the CLR's argument checks. `GetHashCode`
is deterministic where .NET's is seeded per process. Pinning is rejected:
`Pin`, `MemoryHandle`, `MemoryManager<T>` and `MemoryPool<T>`.

### Multidimensional arrays

`T[,]` to `T[,,,,,,,]` (ranks 2 to 8) are the runtime's `MdArray2<T>` to
`MdArray8<T>` (`runtime/Arrays.cs`), one class per rank so that `is`
tests and casts tell ranks apart: the elements in one flat array in
row-major order, as the CLR lays them out, and each dimension's length.
`new T[a, b]` (a negative length is an `OverflowException`, as a total past
`int`'s range is) and nested initializers make them; `a[i, j]` checks the
array for null, then each index against its dimension
(`IndexOutOfRangeException`), for a simple assignment after evaluating the
value, as the CLR's `Set` does; elements may be structs (read, written and
mutated in place, `ref` to them included) or references. `foreach` visits
the elements row-major. `Length`, `LongLength`, `Rank`, `GetLength`,
`GetLongLength`, `GetLowerBound` (0) and `GetUpperBound` are System.Array's
(an out-of-range dimension is an `IndexOutOfRangeException`). `GetType` of
one, and `Array.Copy`/`Clear` and the other `System.Array` statics taking
one, are unsupported.

### Anonymous types

An anonymous type (`new { a = 1, b }`, and those query expressions make
for `let` and further `from` clauses) is the generic class C# compiles it
to, of any number of properties, a class like any other (shared over
reference-type properties as any generic class is): `Equals` compares the
property values as `EqualityComparer<T>.Default` does, `GetHashCode` is
C#'s (a seed from the names, then each value's hash), and `ToString` gives
`{ a = 1, b = x }`, all as C#'s IL has them. `with` on one evaluates the
object, then the new values in order, then makes the new object taking the
other properties from the old one.

### Nullable value types

`int?` and every other `T?` of a value type is the runtime's `Nullable<T>`
(`runtime/Nullable.cs`): a flag and a value, a struct like any other, with
the BCL's `HasValue`, `Value` (throwing `InvalidOperationException`
without one, as does an explicit conversion), `GetValueOrDefault`,
`Equals`, `GetHashCode` (0 without a value) and `ToString` (empty). A value
converts to a nullable of it, `null` to one without a value, and nullables
to each other by their values. Boxing one gives null or its value's box,
and unboxing `null` gives no value. Operators lift as C# lifts them:
arithmetic, bitwise, shifts and user-defined operators give no value unless
both operands have one; `<` and the like are false then, `==` is true for
two without values; `bool?` `&` and `|` are three-valued. Compound
assignments, `++` and `--` lift the same way. `??` takes the value
(converted) or the other side, `??=` assigns only to a null or valueless
target, `a?.B` of a value type gives a nullable of it, and `n?.B` uses a
nullable's value. Patterns on a nullable test `null` against its flag and
everything else against its value; switch cases likewise. In generic code
a type argument's `T?` (with `where T : struct`) is the same type, and
`value == null` on a type argument that is a nullable tests its flag.

### Generics

Instantiations over value types are monomorphized: each gets heap types,
vtables, itables, delegate shapes and functions of its own, lowered from
the generic definition's IL with the type arguments substituted.
Instantiations over reference types share one representation and, where
more than one of them runs it, one body, compiled once over `object`, whose
instructions that depend on the exact type arguments (casts, `new T[]`,
statics of `C<T>`, ...) go through a dictionary per instantiation
(docs/IMPORTER.md, "Shared generics as built"). Discovery is a worklist:
starting from non-generic code, every type the IL mentions is instantiated
(its fields decide its layout), and every member or generic method code
calls, converts to a delegate or constructs is instantiated, whose code is
walked in turn. A generic class's virtual members are compiled with the
class, because its vtable needs them; its other members only once something
reaches them, so generic code is checked per instantiation, and an
uninstantiated generic declaration is only checked by Roslyn. A call through a type parameter
constrained to an interface calls the type argument's implementation
directly, as a constrained call would.

Type arguments nest at most 8 levels deep (arrays count), and a module has at
most 2048 instantiations. Polymorphic recursion, such as `F<T>()` calling
`F<T[]>()`, instantiates without end and is rejected when it crosses the
first bound. Instantiations never cross the module boundary: generic methods
and members of generic classes are not exported.

Each instantiation has its own static fields, initializers and static
constructor, initialized on its own (see [Static state](#static-state)).

### Collections

`List<T>`, `Dictionary<TKey, TValue>`, `HashSet<T>` and `Queue<T>` (and
`KeyValuePair`), which .NET keeps in System.Private.CoreLib, are the
CoreLib's C# ([runtime/Collections.cs](runtime/Collections.cs)); the rest
of System.Collections (`Stack<T>`, `SortedList`, `SortedDictionary`,
`SortedSet<T>`, `LinkedList<T>`, `PriorityQueue`, `OrderedDictionary`) and
all of System.Linq are the SDK's own assemblies, imported as IL
(docs/IMPORTER.md, "Framework assemblies"). Being generic, they reach a
module only when code instantiates them, and only the members it calls.
They follow .NET's algorithms, so programs observe what they would on the
CLR:

- `List<T>`: `Add`, the indexer, `Count`, `Capacity` (growing 4, 8, 16...),
  construction from an array or list, `Insert`, `Remove`, `RemoveAt`,
  `RemoveAll`, `Clear`, `IndexOf` (with a start and count), `LastIndexOf`,
  `Contains`, `Exists`, `Find`, `FindIndex`, `FindLast`, `FindLastIndex`,
  `FindAll`, `TrueForAll`, `ForEach`, `ConvertAll`, `AddRange` and
  `InsertRange` (of an array or list), `GetRange`, `RemoveRange`, `Reverse`
  (all or a range), `Sort()`, `Sort(Comparison<T>)`, `BinarySearch`,
  `CopyTo`, `ToArray`, `EnsureCapacity`, `TrimExcess`.
- `Array`'s static helpers: `Sort` (whole, a range, or with a
  `Comparison<T>`), `BinarySearch`, `Reverse`, `IndexOf`, `LastIndexOf`,
  `Fill`, `Resize`, `Empty`, `Exists`, `Find`, `FindIndex`, `FindLast`,
  `FindLastIndex`, `FindAll`, `TrueForAll`, `ForEach`, `ConvertAll`
  ([runtime/Sorting.cs](runtime/Sorting.cs)). Sorting is a port of the
  CLR's introsort (insertion sort up to 16 elements, median of three,
  heapsort past the depth limit, and the NaN prepass for `float` and
  `double`), so equal keys end up in the CLR's (unstable) order and a
  comparison that throws surfaces as `InvalidOperationException`, as it does
  there. Without a comparison, elements order by the default order (see
  `System.Linq` below); anything else is rejected asking for a comparer or
  `Comparison<T>`.
- `System.Random` ([runtime/Random.cs](runtime/Random.cs)): a seeded one
  runs the CLR's compatible generator, so `new Random(seed)` gives the CLR's
  `Next`, `Next(max)`, `Next(min, max)`, `NextInt64`, `NextDouble`,
  `NextSingle`, `NextBytes`, `Shuffle` and `GetItems` sequences exactly. An
  unseeded one and `Random.Shared` run xoshiro256** as .NET's do, seeded
  from a per-instance counter instead of the operating system, so they are
  deterministic per module instance. `Random` is sealed here: deriving from
  it is rejected.
- `Dictionary<TKey, TValue>`: `Add`, the indexer, `TryAdd`, `TryGetValue`,
  `ContainsKey`, `ContainsValue`, `Remove` (with and without the value),
  `Clear`, `Count`, `Keys`, `Values`. Entries live in insertion order with a
  free list of removed ones, which the next adds reuse most recent first, as
  .NET's do, so enumeration visits entries in the CLR's order after any
  sequence of adds and removes, whatever the hash codes.
- `HashSet<T>`: `Add`, `Remove`, `Contains`, `Clear`, `Count`, with the same
  entry order.
- `Queue<T>`: `Enqueue`, `Dequeue`, `TryDequeue`, `Peek`, `TryPeek`,
  `Contains`, `Clear`, `ToArray`, `Count`.
- `System.Linq` is .NET's own IL: every operator, query expressions, and
  its deferred execution, exceptions and messages; System.Linq's `Sum`,
  `Average`, `Min` and `Max` over decimals are the CoreLib's (the SDK's are
  generic math, which the CoreLib's decimal did not implement when these
  were written). The default
  order (`Comparer<T>.Default`) is the comparer the CLR chooses for `T`:
  numbers, chars, bools and enums by value, `IComparable<T>` types by
  `CompareTo` (a null first; a class deriving from an `IComparable<Base>`
  by its base's, as the interface is contravariant), types implementing
  the non-generic `IComparable` alone by `CompareTo(object)`, the right
  boxed (`ObjectComparer<T>`: a reference equal to itself first, then a
  null first), and nullables of any of them by their values, no value
  first (`NullableComparer<T>`); arrays of the last two sort as the CLR's
  `ArraySortHelper<T>` sorts them, by the comparer's `Compare`, and the
  others as its `GenericArraySortHelper<T>`, by the values' own order.
  Other types, strings among them (the CLR's default order of strings is
  culture-sensitive), have none: the calls that would order by it
  (`OrderBy` without a comparer, `List<T>.Sort()`,
  `Comparer<string>.Default`, a `SortedSet<string>` without a comparer,
  ...) are rejected where they are made.
- Comparers (runtime/Comparers.cs): `IComparer<T>`, `IEqualityComparer<T>`
  and `IComparable<T>` implemented by classes and structs;
  `Comparer<T>.Default`/`Create`, `EqualityComparer<T>.Default`/`Create`,
  `StringComparer.Ordinal` and `OrdinalIgnoreCase` (code units; ignoring
  case, uppercased code points, as .NET's invariant mode compares); the
  culture-sensitive string comparers are rejected. `List<T>.Sort`,
  `BinarySearch`, `Array.Sort` and `BinarySearch` take comparers (a null or
  the default one sorting as the default order does, nulls placed as .NET's
  GenericArraySortHelper places them); `Dictionary` and `HashSet` take
  equality comparers, and `HashSet<T>(IEnumerable<T>)` copies a set with the
  same comparer as .NET's does (keeping its free entries when .NET would,
  its capacities .NET's primes).
- Collection initializers, including `[key] = value`, and `foreach` over
  each collection and over `Keys` and `Values`, whose enumerators are
  structs and check the collection's version as the CLR's do: adding to (or
  setting an element of) a `List`, or adding a new key to a `Dictionary` or
  `HashSet`, while enumerating it faults with 14 on the next step, while
  removing from a `Dictionary` or `HashSet`, clearing one, or replacing a
  value does not, as in .NET.

Elements compare as `EqualityComparer<T>.Default` would: scalars by value
(floating point by `Equals`, so NaN equals NaN and 0 equals -0); a type
implementing `IEquatable<T>` (records, and any class, struct or interface)
by its `Equals(T)`, as the interface dispatches it (a subclass that lists
the interface again with an `Equals` of its own re-implements it, and its
objects compare by theirs, as they order by a re-implemented
`CompareTo`); a nullable by its value; otherwise as
`Equals(object)` does: a class's or struct's override, else class and
interface instances and arrays by identity and structs field by field, each
field by its `Equals(object)`, as `ValueType.Equals` compares them.
Delegates compare by type, method and target, and hash consistently with
that, arrays by identity. Where the CLR
throws, these fault with the code its exception maps to (14, 15, 16, or 10
for `ArgumentException` and `ArgumentNullException`); faults that have no
CLR counterpart (a list longer than the maximum array length) keep theirs.
Hash codes need not match the CLR's (string hashing is even randomized per
process there); they only choose buckets. A struct hashes its fields'.

A class or interface instance used as a hashed key needs an identity hash,
which Wasm GC does not provide. A module that hashes one gives every class
object a hash field, assigned from a module-wide counter the first time the
object is hashed: the root `$Object` holds it after the vtable, and a class
outside the hierarchy holds it last. A module that hashes no reference keeps
its layouts, and the field is not charged to the allocation budget.

### Exceptions

`System.Exception` and the BCL exceptions `SystemException`,
`ApplicationException`, `InvalidOperationException`, `ArgumentException`,
`ArgumentNullException`, `ArgumentOutOfRangeException`,
`NullReferenceException`, `IndexOutOfRangeException`, `ArithmeticException`,
`DivideByZeroException`, `OverflowException`, `InvalidCastException`,
`NotSupportedException`, `NotImplementedException`, `FormatException`,
`KeyNotFoundException`, `SwitchExpressionException`,
`TypeInitializationException` and those the framework assemblies throw
(`ArrayTypeMismatchException`, `PlatformNotSupportedException`, ...) or the
task library does (`TimeoutException`) are
classes of the module (the task library's `OperationCanceledException`,
`TaskCanceledException`, `ObjectDisposedException` and
`AggregateException` are the CoreLib's own, deriving from them), with their parameterless, `(string message)` and
`(string message, Exception innerException)` constructors, and the argument
exceptions' constructors taking a parameter's name (and an
`ArgumentOutOfRangeException`'s actual value); user exception
classes derive from any of them. An exception object carries the fault code
it ends an entry with if nothing catches it: its class's (the table below;
17 for one without a code of its own, including user exceptions), or the
code of the check that threw it.

`Message`, `InnerException` and an argument exception's `ParamName` read
what the constructors stored, and a `TypeInitializationException` has its
`TypeName` and the exception its initializer threw as `InnerException`. A
module that uses none of these keeps exceptions to their fault code. A BCL
exception constructed without a message (or with a null one) has its
class's default message, the CLR's English resource text (`Operation is
not valid due to the current state of the object.`), and so does a user
exception whose constructors reach a BCL class's parameterless one; one
deriving from `System.Exception` itself says what its class is, `Exception
of type 'Namespace.Class' was thrown.` (nested classes after a `+`), and a
type initializer's is `The type initializer for 'Namespace.Class' threw an
exception.` An argument exception's message ends with ` (Parameter
'name')` and an `ArgumentOutOfRangeException`'s with its actual value, as
the CLR composes them. The exceptions the checks throw carry their class's
default message, which is the CLR's for null references, array bounds,
division by zero and arithmetic overflow; where the CLR's message
describes the failure (a cast's types, a missing dictionary key, a
modified collection, the runtime's argument checks), the module's
differs.

A module containing a `try` statement throws Wasm exceptions: one tag, whose
payload is the exception object. `throw` throws it (null throws a
`NullReferenceException`, as in the CLR), and so does every compiler check
the CLR throws from: null references, array bounds, division, casts,
`switch` expressions, `Math.Abs` and `Math.Clamp`, negative array lengths,
and the collections. A `try` with catch clauses runs its block in a
`try_table` that catches the tag, then tries the clauses' type tests in
order; when none matches, the exception is thrown on. A catch clause
runs at its method's call depth: the frames the exception unwound never
returned to take theirs off the depth budget, so the function keeps its
depth in a local and restores it (a loop catching exceptions thrown a few
calls down would otherwise run out of depth). `throw;` rethrows
the exception being handled. A `finally` catches everything (`catch_all_ref`),
runs whether its block completes, throws, or leaves by `return`, `break` or
`continue` (those branches are routed through it), then rethrows
(`throw_ref`) or takes the branch; an exception thrown by the `finally`
replaces the one in flight. Storage written through `this`, `ref` or `out`
before a throw keeps the writes, since those point at the storage itself
(see [Structs](#structs)). Exported entries catch whatever escapes and end
with its fault code, so hosts see the same traps and codes as before. A
module with no `try` statement (and no lazily initialized class, whose
initializer catches) has nowhere to catch an exception and no `finally`
block to run, so there the checks and `throw` end the entry in place with
the exception's code, without creating or throwing the exception: nothing
could tell the difference, except that a thrown exception object is
charged to the allocation budget first.

`when` filters run as in the CLR, in two passes. The CLR first finds the
clause that takes an exception, running the filters on the way, before any
`finally` block between the throw and that clause has run; then it unwinds,
running those `finally` blocks, and runs the clause. Wasm unwinds in one
pass, so a module with filters keeps the first pass itself: a stack of
handler records, one per `try` statement with catch clauses whose block is
running, pushed on entry to the block and popped on every way out of it
(completion, `return`, `break`, `continue`, and exceptions, including the
host's). Every throw, rethrow and throwing check calls a raise function that
asks the records, innermost first, for the clause that takes the exception;
each record's selector is a function of its own with the statement's type
tests and filters, over the enclosing method's variables, which live in
cells the selector reaches. Raise marks the record that answers, then throws; a catch
site takes only the exception its record was marked for, and passes
everything else on. A filter runs with the stack empty, so an exception it
throws is caught inside it or makes it false, as in the CLR. An exported
entry is the handler of last resort: when no clause takes an exception,
every filter has run, then the `finally` blocks run on the way out, and the
entry ends with the exception's code (the CLR leaves the order of an
unhandled exception's `finally` blocks to the host; here the entry behaves
like a catch-all). The stack is an array of records the module reuses, grown
by doubling when a `try` nests deeper than ever before, so entering a `try`
allocates nothing, as in .NET; the growth, bounded by the deepest nesting, is
bookkeeping and not charged to the allocation budget. A
module without filters keeps the one-pass lowering: type tests are pure,
so running them after the `finally` blocks in between is not observable.

The budgets are not exceptions: running out of fuel, call depth or the
allocation budget, and allocating an array above the maximum length trap,
and no `catch`, filter or `finally` runs. Exceptions a host import throws
are not C# exceptions: they pass through `catch` clauses and filters, run
`finally` blocks, take the handler records they leave off the stack, leave
a static initializer they cross uninitialized rather than failed, and leave
the entry unchanged. That is host policy: the embedder owns aborting its
own calls, and C# code cannot swallow them.

### Strings

A string is a Wasm GC array of UTF-16 code units (packed `i16`), and null is
a null reference. Nothing writes one after the runtime builds it, so strings
are immutable. A literal is an immutable global built by a constant
expression (`array.new_fixed`), so evaluating it allocates nothing and equal
literals are one object, like the CLR's interned literals; literals are
limited to 10000 characters. Strings work wherever other references do:
locals, fields, struct fields, arrays, generic arguments, collection
elements and `Dictionary`/`HashSet` keys, captured variables.

`Length` and the indexer compile inline, checking for null (5) and range
(6, `IndexOutOfRangeException`) as the CLR does. The rest is C# the
compiler supplies, [runtime/Strings.cs](runtime/Strings.cs), compiled with a
module that uses strings: `==` and `!=`, `Equals` and `string.Equals`
(ordinal, as the CLR's), `string.IsNullOrEmpty`, `string.CompareOrdinal`,
`Substring` (throwing `ArgumentOutOfRangeException`, 16), `IndexOf(char)`,
`Contains(char)`, `string.Empty`, `string.Concat` of two to four strings, `+`
and `+=`, interpolation with alignments and format strings (`{x,8:F2}`),
`switch` and `is` against string constants, and `ToString` on every value.
Concatenation treats null as the empty string. Values format exactly as the
CLR's `ToString` does with the invariant culture:

- Integers of every width, with no format or with the standard formats (C,
  D, E, F, G, N, P, R, X) and custom formats (`"0000"`, `"#,##0.00"`,
  `"0.###E+0"`, sections split by `;`), invalid ones throwing
  `FormatException`.
- `float` and `double` with the shortest digits that round-trip (the
  default and R), or their exactly rounded digits for a precision (E, F,
  G5, N, P, C and custom formats, which round the CLR's way, to 15 or 7
  significant digits first), from [runtime/Number.cs](runtime/Number.cs), a
  port of the Dragon4 algorithm .NET falls back on (its Grisu fast path
  gives the same digits whenever it succeeds). It costs a few hundred to a
  few thousand steps of fuel a number.
- Enums by name, or as a `[Flags]` combination (`Read, Write`), or as a
  number when no member matches; enums take the G, F, D and X formats as
  constants. An enum's names reach a module only where it prints one.
- Bools as `True` and `False`, chars as themselves, records as described
  under [Records](#records), structs by their type's name, and objects by
  their `ToString` (see [Objects and boxing](#objects-and-boxing)).

The rest of the string and char members are C# too, in
[runtime/Text.cs](runtime/Text.cs), each reaching a module only where code
calls it, all with the invariant culture and checked against the CLR by
`tests/Text.cs` and `tests/Characters.cs`:

- Ordinal searching and comparison: `Contains`, `StartsWith`, `EndsWith`,
  `IndexOf`, `LastIndexOf`, `IndexOfAny`, `LastIndexOfAny`, `Equals`,
  `string.Equals` and `string.Compare`, over chars, or over strings with a
  `StringComparison` of `Ordinal` or `OrdinalIgnoreCase` (a culture's
  comparison throws `NotSupportedException`). The overloads that compare
  by the current culture (`StartsWith(string)`, `IndexOf(string)`,
  `CompareTo`, `string.Compare(a, b)`) are rejected with that advice:
  linguistic collation is data a module does not have.
- `Replace`, `Insert`, `Remove`, `PadLeft`, `PadRight`, `Trim`, `TrimStart`
  and `TrimEnd` (whitespace or given chars), `ToUpper`, `ToLower` and their
  invariant forms (Unicode simple case mapping, surrogate pairs included),
  `ToCharArray`, `Split` (every separator form, a count and
  `StringSplitOptions`, piece for piece as .NET splits), `string.Join` (of arrays and enumerables),
  `string.Concat` of strings, objects or enumerables, `string.IsNullOrWhiteSpace` and
  `new string(char, int)` / `new string(char[] ...)`.
- `string.Format`: with a constant format it is lowered as an interpolated
  string is, each item formatted by its argument's own type (numbers with
  format strings, enums by name or with G, F, D and X); with another format
  the runtime parses it as .NET does and formats boxed numbers with a format
  string, strings, bools and chars ignoring one; another object with a
  format string there throws `NotSupportedException`, since an enum's box
  is not told apart at run time. Malformed formats throw `FormatException`.
- `System.Text.StringBuilder` (a runtime class): the `Append` overloads,
  `AppendLine`, `AppendFormat`, `AppendJoin`, `Insert`, `Remove`, `Replace`,
  `Clear`, `Length`, the indexer, `ToString` and `Equals`; not `Capacity`,
  which is the CLR's own growth policy.
- `char` classification (`IsDigit`, `IsLetter`, `IsWhiteSpace`, `IsUpper`,
  ..., `GetUnicodeCategory`, the `IsAscii...` helpers), `ToUpper`,
  `ToLower`, `char.ToString`, `ConvertFromUtf32` and `ConvertToUtf32`, from
  Unicode tables generated by [runtime/unicode.py](runtime/unicode.py) and
  checked for every code unit; a module that classifies or cases a
  character beyond Latin-1 carries them, about 20 KB.
- `Parse` and `TryParse` for every integer type (`NumberStyles.Integer`),
  `float` and `double` (`Float | AllowThousands`, correctly rounded from all
  the digits, `Infinity` and `NaN` included), `bool` and `char`, with the
  CLR's `FormatException`, `OverflowException` and `ArgumentNullException`.

C# 13's `params ReadOnlySpan<T>` overloads, which overload resolution
prefers, reach these members as arrays, and collection expressions (`[a,
b]`) create arrays for them. Their `IFormatProvider` overloads are rejected
(`decimal`'s take the invariant culture; see [decimal](#decimal) and
[Cultures](#cultures)). String hashing (FNV-1a over the code units, which
`GetHashCode` returns too) differs from the CLR's randomized one; the
scalars' hash codes are the CLR's. Strings never cross the module boundary: an export or import with a
string parameter or result is not one (see [Exports](#exports)).

### Static state

Static fields are module globals, so state persists across exported entries
on one instance; a host that wants a fresh script instantiates the module
again. Each class (each generic instantiation) is initialized as the CLR
does it: its static field initializers in declaration order, then its
static constructor, once, when the class is first used, on the budget of
the entry that uses it.

- A class with a static constructor is initialized at the first access to
  one of its static fields, call of one of its static methods (properties
  and operators included, after the arguments), or run of one of its
  instance constructors; for a struct, also the first call of an instance
  method, as CoreCLR does (ECMA-335 II.10.5.3.1), but not a default value.
  Constructing a derived class initializes it, then its base when the base
  constructor runs; using a derived class's statics does not initialize its
  base. A store to a static field evaluates the value first.
- A class with only field initializers (beforefieldinit in the CLR, which
  may initialize it at any time before the first access to a static field)
  is initialized at that first access. Two kinds need no code: if every
  initializer is a constant, the globals start with the values; if every
  one is pure (constants, arithmetic without division, reads of the class's
  own statics, arrays of constant length, objects and structs built by
  constructors that only store their arguments), they run before the first
  entry's code, as the CLR may initialize such a type early, and the entry
  is not charged for them.
- An exception escaping an initializer becomes a
  `TypeInitializationException`, thrown where the class was used, and
  catchable there; the class is failed for good, and every later use, in
  this entry or a later one, throws the same exception object again. An
  initializer that uses a failed class fails in turn.
- A class used while its initializer runs (by the initializer itself, by
  another class's initializer it uses, or by an entry a host import makes
  meanwhile) is seen partly initialized, as the CLR's same thread sees it.
- An initializer stopped by an exception from the host is not failed: the
  class is initialized again at its next use, with its static fields reset
  to their defaults first, so nothing observes a half-run initializer.

A trap ends the module, as an unhandled exception ends a .NET process: a
budget running out, a check whose exception nothing catches, an exception
escaping an entry, or an engine trap. Every later entry faults with 18, and
the host instantiates the module again. The module notices a trap it did not
raise itself by counting entries (`__entries`) against the import calls they
are made from (`__imports`), in every module: an entry that finds them
different, or an import call that returns to find a nested entry trapped (a
host swallowed the trap), poisons the module. An exception from the host is
not a trap: the embedder chose to end that call, and the module stays usable.

`--recover-after-trap` keeps a module usable after a trap instead. An entry
that finds the counts different knows every entry before it was abandoned by
a trap and resets every class left running, as for a host exception. An
import call that returns to find a nested entry trapped resets the classes
of the entries above it, and restores its own budgets, fault code and handler
records. A host that swallows a trap and then enters again before returning
abandons the entries below: the classes they were initializing are reset
under them, so each ends with fault 12 when its import call returns.

Static initialization of classes other than these never runs code the
program could observe before use. Checks are elided in a class's own
initializer and static constructor, and in its members that already
triggered it on entry.

## GC representation

Source objects become Wasm GC structs. Arrays become Wasm GC arrays,
not offsets into a linear-memory heap. Heap types and the signatures of
internal functions occupy one recursive type group, so self-referential
fields, forward type references and function references are representable;
host imports and exported entries keep standalone signatures.

A sealed class without a base or interfaces is a plain final struct of its
fields. Every other class, and every record class, is a Wasm subtype (`sub`) of a root `$Object`
struct whose immutable field 0 holds the class's vtable, followed by its
base's fields and then its own. A vtable is a struct of immutable function references, one per
virtual slot, extending its base class's vtable; each concrete class's
vtable is an immutable global built by a constant expression, and
`struct.new` stores it before any constructor runs, so a virtual call from a
base constructor reaches the override, as in the CLR. An override receives
`this` as the class that introduced its slot and casts it once. When a module
declares interfaces, the root vtable also holds an array of itables indexed
by a dense interface id; an itable's slots are thunks that cast `this` and
call the implementation. A value of an interface type is a `$Object`
reference. In a module whose code dispatches `ToString`, `GetHashCode` or
`Equals(object)` (on a record that is not sealed, or on an interface or
object value) the root vtable then holds slots for those `System.Object`
members; the classes that do not override them hold identity `Equals` and
`GetHashCode` and a `ToString` printing their name where code needs them,
and null otherwise. A record's equality compares vtables
where C# compares `EqualityContract`. A slot that no reachable call
dispatches through, on a receiver whose static class is the vtable's class
or one of its bases, holds null as well, and the functions only such slots
would reach are left out of the module.

A delegate is a struct holding its function, whose function takes the
delegate itself first, the ids of its delegate type and of the method it
stands for, and its target: the object of the class C# compiles a
lambda's captured variables to, a method group's object, or null. A
method group over one of `System.Object`'s virtual members holds the
object (a value boxed) as any object, and its function calls the helper
that dispatches the member on any object (a class's vtable slot, a box's
member, a string's or array's own). Delegate types whose lowered
signatures agree share the struct. Two delegates are equal, as the CLR's
are, when they have the same type, method (a virtual method's slot, since
the target picks the override) and target, so a method group over one
object equals another over it, and a lambda equals itself; `+` and `+=`
combine delegates into a multicast subtype holding the list, whose function
calls each in turn and returns the last result, and `-` and `-=` remove the
last run equal to the removed one, as `Delegate.Combine` and `Remove` do
(null when nothing is left). A field-like event is storage of its delegate
type, combined and removed in by `+=` and `-=` outside its class and read
as a delegate inside; an event with `add` and `remove` accessors calls
them. An interface's events are its `add` and `remove` methods, in its
itable like any other members, abstract or with default bodies: a class
implements one with a field-like event (whose accessors become functions
that combine and remove in its storage), with accessors, or explicitly, and
`+=` and `-=` on an interface-typed receiver (or a type parameter
constrained to the interface) call the implementation's accessor.
Captured variables are fields of those classes (C#'s display classes),
which every function using a variable shares. A struct is flattened into Wasm values, or held in a box where it is
storage; see [Structs](#structs).

The compiler emits `struct.new`, `struct.new_default`, `struct.get`,
`struct.set`, `array.new_default`, `array.new_fixed`, `array.get`,
`array.set`, `array.len`, `ref.test`, `ref.cast`, `ref.func`, `call_ref`,
nullable and non-null typed references, and reference equality, and with
exception handling `try_table`, `throw` and `throw_ref`; strings add
`array.get_u` of their packed `i16` code units, and `Vector128<T>` SIMD's
`v128` instructions. There are no Wasm
table/data sections, only a declarative element segment for the functions
code references (and, with exception handling, one tag), and no embedded
.NET runtime in the generated modules. The only linear memory is the
canonical ABI's, in a module whose WIT glue passes strings or lists (see
[docs/WIT.md](docs/WIT.md)); it holds nothing but values crossing the
boundary. Explicitly annotated host
methods become typed function imports; other modules remain import-free.

An `object` is an `eqref`. A module with object values makes every class
polymorphic (discovery starts over when it finds out late), so that every
object but a string, an array or a delegate is a `$Object` whose vtable
answers `Equals`, `GetHashCode` and `ToString`, through helpers that handle
those three kinds apart. A boxed value type `V` is a final subtype of
`$Object`, holding the value (a scalar, a union's reference, or a struct's
storage box) after the vtable and hash; its vtable holds the itables of
`V`'s interfaces, whose thunks call the struct's methods on that storage,
and `V`'s object members.

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
| Allocation units | 1,048,576 | Monotonic logical charge: 16 + 8×fields/elements (objects, arrays, delegates, closures and environments); NOT actual heap bytes |
| Maximum array length | 65,536 | Per allocation; negative lengths are rejected |

CLI overrides are `--fuel`, `--depth`, `--alloc-units`, `--max-array`, and
`--recover-after-trap` (see [Static state](#static-state)) keeps a module
usable after a trap.

Before a compiler-inserted fault, global `__fault` is set and `unreachable` traps.
In a module that handles exceptions, the faults with a CLR exception throw it
instead, and one that escapes an entry sets `__fault` to its code and traps.
The host catches the runtime's trap result and reads `__fault`. The trap
poisons the module: every later entry faults with 18, so the host instantiates
it again. With `--recover-after-trap`, `__fault` is reset on the next entry,
which runs.

| Code | Fault | CLR counterpart |
|---:|---|---|
| 1 | Control-step fuel exhausted | none |
| 2 | Call depth exceeded | `StackOverflowException` |
| 3 | Allocation charge exhausted | none |
| 4 | Array length negative (or, not catchable, above the maximum) | `OverflowException` |
| 5 | Null reference, including a null delegate or a null virtual method group target | `NullReferenceException` |
| 6 | Array index out of range | `IndexOutOfRangeException` |
| 7 | Integer division by zero | `DivideByZeroException` |
| 8 | Signed division/remainder overflow | `OverflowException` |
| 9 | `Math.Abs` of the minimum value; checked arithmetic and conversions that overflow | `OverflowException` |
| 10 | `Math.Clamp` with minimum above maximum; a delegate over a null target of a non-virtual method; a duplicate `Dictionary` key, a null key or predicate | `ArgumentException`, `ArgumentNullException` |
| 11 | `switch` expression with no matching arm | `SwitchExpressionException` |
| 12 | With `--recover-after-trap`, the entry was abandoned: its host swallowed a trap and entered the module again before returning to it (see [Static state](#static-state)) | none |
| 13 | Failed downcast, cast to an interface or unboxing | `InvalidCastException` |
| 14 | A collection modified while being enumerated; `Dequeue`, `Pop` or `Peek` of an empty queue or stack | `InvalidOperationException` |
| 15 | A missing `Dictionary` key read through the indexer | `KeyNotFoundException` |
| 16 | A `List` index outside it; a negative capacity | `ArgumentOutOfRangeException` |
| 17 | Any other exception, including user exceptions, escaping an entry | its own |
| 18 | The module is poisoned: an earlier entry trapped | the process has ended |
| 19 | An object operation the CLR answers with what is not kept here: printing a boxed union as an object | a value |
| 20 | A wait for a task that has not completed (`Task.Result`, `Wait`, `GetAwaiter().GetResult()`): the module's one thread would wait for ever | a deadlock |

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

The sum and vector results are covered by the compiler integration tests.

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

A module may have up to 65,536 GC types, functions and globals each (V8
allows a million of each); a program needing more is rejected with the
count it needs.

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

- `src/Gameplay.Compiler`: the module layer (`Frontend*.cs`: declarations,
  classes and vtables, structs, records, boxes, exceptions, strings, identity
  hashes, interfaces, delegates, generic instantiation, the module boundary,
  emission), lowering primitives (`FunctionEmitter*.cs`: shell, numerics,
  casts and type tests, delegates, struct places and boxes, records, boxes
  and object members, exceptions and filters, strings, equality and
  hashing, intrinsics), the binary writer (`Wasm.cs`), stackification
  (`Wasm.Locals.cs`, docs/IMPORTER.md "Stackification as built"), the
  source generators' driver (`Generators.cs`), libraries
  (`Frontend.Libraries.cs`: `--library` and `--reference`) and the CLI. The CIL
  importer over them:
  `Il.Metadata.cs` (tokens to Roslyn symbols), `Il.Code.cs` (the instruction decoder), `Il.Flow.cs` (blocks,
  stack typing, exception areas), `Frontend.Import*.cs` (registration and
  discovery from IL), `Frontend.CoreLib.cs` (the compilation against .NET's
  reference assemblies, the facades that resolve them to the CoreLib, the
  framework assemblies imported above it), `Il.Folding.cs` (import-time
  constant folding of feature switches, `IsSupported` and the like),
  `Frontend.Arrays.cs` (with multidimensional arrays, the covariant family
  of arrays), `Il.RuntimeAsync.cs` and `Frontend.RuntimeAsync.cs`
  (the splitter of runtime-async methods and their frames),
  `Frontend.Simd.cs` and `FunctionEmitter.Simd.cs` (Vector128 as `v128`
  and its members as SIMD instructions),
  `FunctionEmitter.Il*.cs` (structuring, instructions, calls, filters).
- `corelib/allowlist.txt`, `corelib/framework/*.txt`: API control: the rules over the members gameplay code references, and the
  members each imported framework assembly references
  (`Frontend.Allowlist.cs`, docs/IMPORTER.md "API control").
- `corelib/`: the gameplay CoreLib the compiler imports. `generator/` is
  coresurface, which writes .NET's declarations of the types
  `surface.txt` allows (from dotnet/runtime's reference sources, pinned in
  `runtime/dotnet`) with extern members,
  compiles them with the runtime layer (`runtime/*.cs`) and CoreLib's own
  sources (the `.cs` files here: among them
  `Vector128.cs`, the Vector128 members that are not single instructions,
  `Numerics.cs`, what System.Numerics' sources need instead of
  reinterpreting memory, and `BigInteger.cs` and `Complex.cs`, their text
  and hash, beside the patches coresurface applies to
  dotnet/runtime's sources, pinned with them) into
  `Gameplay.CoreLib.dll`, and reports what .NET declares that CoreLib's own
  types lack (`buck2 build tilde//aseipp/cs2wasm:corelib[report.txt]`).
- `tools/`: for the importer's upkeep when the pinned .NET changes:
  `bclscan` (how much of the class library's IL could be imported) and
  `ilinspect` (one assembly's references, types, member references and
  methods' IL); each has a README.
- `sdk/Gameplay.cs`: the attribute declarations, embedded in the compiler and
  meant for IDE projects. `sdk/Frames.cs`: `Gameplay.Frames` for IDE
  projects and the CLR oracle (the module's is the CoreLib's,
  `corelib/Frames.cs`).
- `runtime/`: the runtime layer, compiled into the CoreLib, whose members a
  module includes as its code reaches them. `runtime/Collections.cs`: the
  generic collections; `runtime/Strings.cs`: the string members;
  `runtime/Number.cs`: number
  formatting; `runtime/Shims.cs`: framework members written in C#, which
  calls of the framework's run (see `Frontend.Shims.cs`); `runtime/Math.cs`:
  the transcendental functions and rounding; `runtime/Tuples.cs`: the
  `ValueTuple` structs; `runtime/Nullable.cs`: `Nullable<T>`;
  `runtime/Text.cs`: the string, char, StringBuilder and parsing members,
  over the tables of `runtime/Unicode.cs`, which `runtime/unicode.py`
  generates; `runtime/Sorting.cs`: sorting, searching and the `Array`
  helpers; `runtime/Random.cs`: `System.Random`; `runtime/Ranges.cs`:
  `System.Index` and `System.Range`; `runtime/Decimal.cs`: `System.Decimal`
  (`runtime/DecimalMath.cs`: its generic math);
  `runtime/Memory.cs`: `Memory<T>` and `ReadOnlyMemory<T>`; `runtime/Culture.cs`:
  the invariant culture; `runtime/Convert.cs`: `System.Convert`;
  `runtime/Canonical.cs`: the boundary memory the WIT glue uses. None is
  for IDE projects, which have the BCL's.
- `../witgen/src/csharp/`: witgen's C# backend, which writes a world's
  bindings for gameplayc (Rust; `memory.rs` is the canonical ABI glue,
  `tasks.rs` async functions', `channels.rs` futures' and streams');
  `defs.bzl`: the Buck macros;
  `tests/wit`: the world exercising every binding construct, `echo.wit`,
  which a component runtime calls, and `tasks.wit`, `sleepy.wit` and
  `files.wit`, async functions, futures and streams
  (`tests/wit-tasks.mjs`).
- `examples/console`: Breakout and Fireworks against the console SDK's `game`
  world, linked by wlink and run on the console's web, headless and terminal
  hosts.
- `engine/`: Kiln, an entity-component-system engine for gameplayc games
  (its source generator, the world and services, and its console platform);
  `examples/lichgate`: Lichgate, a roguelite built on it.
- `tests/libraries`, `tests/Libraries.cs`: two gameplay libraries and the
  module over them (see [Libraries](#libraries)).
- `tests/generator`, `tests/generators.mjs`: a source generator and the
  gameplay code using it, compiled by gameplayc and by csc and compared
  (`:generator-test`, see [Source generators](#source-generators)).
- `tests/Features.cs`, `tests/features.mjs`: statics, enums, switches,
  patterns, properties, partial classes, export naming, wide numerics.
- `tests/behavior.mjs`: every suite and rejection case on any compiler command,
  and `tests/corpus`: small programs across the language, each of which must
  compile into a valid module or be rejected with a diagnostic, never fail
  internally.
- `examples/Gameplay.cs`: GC vector and integer array example.
- `examples/HeapGameplay.cs`: particle simulation, cyclic graph, maze search, and allocation pressure.
- `tests/Cases.cs`, `tests/integration.mjs`: native, SDK-less, end-to-end acceptance suite.
- `tests/semantics.mjs`: shared behavior checks for original and optimized Wasm.
- `tests/Constructors.cs`, `tests/constructors.mjs`: construction order and resource-limit cases.
- `tests/Inheritance.cs`, `tests/Interfaces.cs`, `tests/Delegates.cs` and their `.mjs` checks:
  virtual dispatch and construction order, interfaces, casts and type patterns, delegates,
  lambdas, local functions and captured variables; `tests/InterfaceEvents.cs`: interfaces'
  events, implemented field-like, with accessors, explicitly and by default bodies.
- `tests/Generics.cs`, `tests/generics.mjs`: generic classes, interfaces, methods,
  delegates and local functions, constraints, and static state per instantiation.
  `tests/GenericMath.cs`: `INumber<T>` and the other generic
  math interfaces over the primitive numeric types, and their checked,
  saturating and truncating conversions (`tests/WideMath.cs` the rest of
  the numeric types).
- `tests/IlAccepted.cs`: the code of the cases the retired IOperation
  frontend rejected and the compiler compiles (`acceptedCases` in
  `tests/rejections.mjs`), against the CLR.
- `tests/IlRegressions.cs`: what the compiler once compiled wrongly or
  rejected, against the CLR.
- `tests/Framework.cs`: what the compiler imports from the SDK's
  framework assemblies (System.Collections' collections, their exceptions
  and messages, System.Linq) against the CLR.
- `tests/Async.cs`: async methods, awaits, the task
  library's results, exceptions, combinators, ContinueWith and
  cancellation, async iterators, `await foreach` and `await using`, and
  the frame loop, and shapes of async bodies (awaits in handlers,
  filters, loops, recursion, what is on the stack across an await, generic
  and struct methods), each case under a single-threaded
  SynchronizationContext of its own on both sides, against the CLR (with
  `sdk/Frames.cs`, the frame loop for ordinary .NET projects), compiled
  twice: as state machines (`async`) and as runtime-async methods
  (`async-runtime`);
  `tests/Frames.cs` and `tests/frames.mjs`: what the frame
  loop does that the CLR has no counterpart of (game time, the queue of
  what the CLR runs on its thread pool and its ExecutionContext, fault 20,
  budgets, continuations past the call depth).
- `tests/Simd.cs`: Vector128 over every element type against
  the CLR's hardware-accelerated one, bit for bit; `tests/Vectors.cs`:
  System.Numerics' vectors, quaternions, planes and matrices against the
  CLR's; `tests/SimdPlatform.cs` and `tests/simd.mjs`: what .NET leaves to
  the platform (MinNative of NaN, MultiplyAddEstimate, which vectors are
  accelerated), as it is here.
- `tests/BigIntegers.cs` and `tests/Complexes.cs`: `BigInteger` and
  `Complex` against the CLR's (arithmetic, conversions, text, parsing,
  generic math); `tests/NativeIntegers.cs` and `tests/native-integers.mjs`:
  native integers as values, and BigInteger's hash, as they are here;
  `tests/WideMath.cs`: generic math over `nint`, `nuint`, `Int128`,
  `UInt128` and `Half`, the conversions between every pair of numeric
  types, and the 128-bit integers' and every `Half`'s text, against the
  CLR's.
- `tests/Time.cs`: `TimeSpan`, `DateTime`, `DateTimeOffset`,
  `Guid`, `Lazy<T>` and `Stopwatch` from the gameplay CoreLib (arithmetic,
  checks, formatting, parsing) against the CLR's, and what holds of the host's
  clocks and randomness.
- `tests/Structs.cs`, `tests/structs.mjs`: struct copies, mutation through `this`, `ref`
  and `out`, structs in fields, arrays, statics and closures, operators, and generic
  code over structs.
- `tests/Collections.cs`, `tests/collections.mjs`: the collections, their enumeration
  order after seeded adds and removes, faults, and modification while enumerating.
- `tests/Exceptions.cs`, `tests/exceptions.mjs`: catch clauses and filters, finally on
  every exit, rethrows, exceptions across calls, the exceptions checks throw, and
  uncatchable budgets; `tests/TypeInitialization.cs` and `tests/type-initialization.mjs`:
  when static constructors run and what failing ones throw.
- `tests/Strings.cs`, `tests/strings.mjs`: literals, equality, concatenation,
  integer formatting, interpolation, string switches, members, strings in
  collections and structs, and the exceptions strings throw.
- `tests/ExceptionMessages.cs`, `tests/messages.mjs`: messages, inner exceptions, and
  the type initialization exception's.
- `tests/Unions.cs`, `tests/unions.mjs`: unions and closed classes.
- `tests/Decimals.cs`: `decimal`'s arithmetic, conversions, rounding, text,
  parsing, hashing and messages, and decimal in the language, against the CLR.
- `tests/Formatting.cs`, `tests/formatting.mjs`: numbers formatted with and
  without format strings (random and boundary doubles and floats, every
  integer width), enum names, type names, exception text, scalar hashes.
- `tests/Transcendentals.cs`: `Math` and `MathF` against the CLR's libm;
  `tests/Tuples.cs`: tuples, deconstruction, tuple equality and text;
  `tests/Nullables.cs`: nullable value types; `tests/Parameters.cs`: params,
  optional, named and `in` parameters; `tests/Statements.cs`: `using`,
  `lock`, disposing and string `foreach` loops and `new object()`;
  `tests/Enumerables.cs`: the enumeration interfaces over classes, arrays,
  strings and collections; `tests/Iterators.cs`: iterators across
  statements, disposal and exceptions; `tests/Linq.cs`: System.Linq and
  query expressions; `tests/Anonymous.cs`: anonymous types;
  `tests/Text.cs` and `tests/Characters.cs`: string, char and StringBuilder
  members, composite formatting and parsing, and every code unit's
  classification and casing; `tests/Jumps.cs`: `goto`, `goto case` and
  `goto default`; `tests/Checked.cs`: checked arithmetic and conversions;
  `tests/Ranges.cs`: indices, ranges, list and tuple patterns; `tests/References.cs`:
  ref arguments, ref locals and ref returns over elements, fields and statics; `tests/EnumMembers.cs`:
  `Enum`'s generic members; `tests/Types.cs`:
  `typeof`, `GetType` and `System.Type`; `tests/Dispatch.cs`:
  covariant returns, default and static interface members and generic
  virtual methods; `tests/Numerics.cs`:
  the numeric types' generic math statics and `HashCode`; `tests/Initializers.cs`:
  nested initializers and collection expressions; `tests/Regressions.cs`:
  what the differential fuzzer found; `tests/Multicast.cs`: combined delegates,
  delegate equality and names, and events; `tests/Sorting.cs`: sorting,
  searching, the array and list helpers and seeded `Random` sequences.
  These run only in the differential suite.
- `tests/Boxing.cs`, `tests/boxing.mjs`: boxes, unboxing, type tests and patterns
  on objects, interface calls on boxed structs, object equality, hashing and
  printing, objects as keys, and unions of value types, unions and interfaces.
- `tests/Records.cs`, `tests/records.mjs`: records and record structs, their
  equality across inheritance, `with`, copy constructors, printing,
  deconstruction and recursive patterns, records as keys, declared members,
  and primary constructors.
- `tests/Poisoning.cs`, `tests/poisoning.mjs`: modules poisoned by traps, and not by
  host exceptions; the other suites compile with `--recover-after-trap`.
- `tests/Filters.cs`, `tests/filters.mjs`: two-pass exception handling, filters
  against nested finally blocks, throwing filters, filters across calls, rethrows,
  and exceptions no clause takes.
- `tests/Combinations.cs`, `tests/combinations.mjs`: generic structs, nested collections,
  generic static state, and exceptions in generic code, together.
- `tests/suites.mjs`: common module list for Node, SpiderMonkey, and Binaryen checks.
- `tests/failures.mjs`: the report of the runs that check every case and
  list each that failed (behavior, differential).
- `tests/differential.mjs`, `tests/reference`: actual CLR-versus-Wasm execution comparisons
  (`:reference` is the CLR oracle).
- `examples/HostedGameplay.cs`, `examples/game-host.mjs`: typed host imports and persistent frame state.
- `tests/spidermonkey.mjs`: adapter for the Mozilla shell.
- `tests/rejections.mjs`: unsupported-source fixtures, and the programs the
  retired IOperation frontend rejected that compile (`acceptedCases`).
- `tests/encoding.mjs`: independently hand-assembled Wasm probes (actually run here).
- `BUILD`: the Buck2 targets and tests.

## References

Official specifications/documentation used while preparing the prototype:

- .NET 11 SDK download and full version:
  https://dotnet.microsoft.com/en-us/download/dotnet/11.0
- Roslyn package:
  https://pkgs.dev.azure.com/dnceng/public/_packaging/dotnet-tools/nuget/v3/index.json
  (Microsoft.CodeAnalysis.CSharp 5.11.0-1.26425.128)
- Wasm 3.0 completion:
  https://webassembly.org/news/2025-09-17-wasm-3.0/
- Binary type and instruction encodings:
  https://webassembly.github.io/spec/core/binary/types.html
  https://webassembly.github.io/spec/core/binary/instructions.html

Third-party packages and embedded reference metadata retain their upstream
licenses. Preserve the .NET/Roslyn notices applicable to the actual dependencies
when distributing the compiler.

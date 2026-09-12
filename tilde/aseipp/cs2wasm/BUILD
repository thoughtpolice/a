# SPDX-FileCopyrightText: © 2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

load("@root//buck/shims:shims.bzl", depot = "shims")
load(":defs.bzl", "gameplay")

# The compiler embeds the targeting pack's reference assemblies gameplay
# code compiles against (see README.md, "Pinned toolchain"), beside the
# CoreLib they resolve to.
REFERENCE_ASSEMBLIES = [
    "System.Collections",
    "System.Linq",
    "System.Memory",
    "System.Numerics.Vectors",
    "System.Runtime",
    "System.Runtime.InteropServices",
    "System.Runtime.Intrinsics",
    "System.Runtime.Numerics",
    "System.Threading",
]

[
    depot.csharp.reference_assembly(
        name = name + ".ref",
        assembly = name,
    )
    for name in REFERENCE_ASSEMBLIES
]

# The framework's implementation assemblies the compiler imports over the
# gameplay CoreLib (docs/IMPORTER.md, "Framework assemblies"): the pinned
# SDK's own, the IL the CLR the differential oracle runs on executes.
FRAMEWORK_ASSEMBLIES = [
    "System.Collections",
    "System.Linq",
]

depot.genrule(
    name = "framework",
    outs = {
        name + ".dll": [name + ".dll"]
        for name in FRAMEWORK_ASSEMBLIES
    },
    cmd = " && ".join([
        "cp $(location toolchains//csharp:dotnet)/shared/Microsoft.NETCore.App/*/{}.dll $OUT/".format(name)
        for name in FRAMEWORK_ASSEMBLIES
    ]),
)

GAMEPLAYC_RESOURCES = {
    "Gameplay.Compiler.Binding.Gameplay.cs": "sdk/Gameplay.cs",
    "Gameplay.Compiler.CoreLib.dll": ":corelib[Gameplay.CoreLib.dll]",
    "Gameplay.Compiler.CoreLib.pdb": ":corelib[Gameplay.CoreLib.pdb]",
} | {
    "Gameplay.Compiler.Reference.{}.dll".format(name): ":{}.ref".format(name)
    for name in REFERENCE_ASSEMBLIES
} | {
    "Gameplay.Compiler.Framework.{}.dll".format(name): ":framework[{}.dll]".format(name)
    for name in FRAMEWORK_ASSEMBLIES
} | {
    "Gameplay.Compiler.FrameworkReferences.{}.txt".format(name): "corelib/framework/{}.txt".format(name)
    for name in FRAMEWORK_ASSEMBLIES
} | {
    "Gameplay.Compiler.Allowlist.txt": "corelib/allowlist.txt",
}

# `buck2 run tilde//aseipp/cs2wasm:gameplayc -- -o out.wasm examples/Gameplay.cs`
depot.csharp.binary(
    name = "gameplayc",
    srcs = glob(["src/Gameplay.Compiler/**/*.cs"]),
    implicit_usings = True,
    invariant_globalization = True,
    lang_version = "14.0",
    nullable = "enable",
    resources = GAMEPLAYC_RESOURCES,
    unsafe = False,
    visibility = ["PUBLIC"],
    warnings_as_errors = True,
    deps = ["third-party//csharp:Microsoft.CodeAnalysis.CSharp"],
)

# The gameplay CoreLib (see docs/IMPORTER.md): the framework surface
# coresurface generates from .NET's reference sources, allowed by
# corelib/surface.txt, compiled by it with the runtime layer and CoreLib's
# own sources into the core library the compiler imports (`:corelib`; its
# `[report.txt]` lists what was kept, dropped and is missing).
DOTNET_RUNTIME_REFERENCE_SOURCES = [
    "//aseipp/cs2wasm/runtime/dotnet:" + name
    for name in [
        "System.Collections.cs",
        "System.Linq.cs",
        "System.Memory.cs",
        "System.Numerics.Vectors.cs",
        "System.Runtime.InteropServices.cs",
        "System.Runtime.Intrinsics.cs",
        "System.Runtime.Numerics.cs",
        "System.Runtime.cs",
        "System.Threading.cs",
    ]
]

# dotnet/runtime's implementation sources the CoreLib takes where they fit
# (each member that does not compile against it is dropped), and the
# resource strings they throw with: System.Private.CoreLib's, and
# System.Runtime.Numerics's BigInteger and Complex (docs/IMPORTER.md,
# "System.Runtime.Numerics as built").
DOTNET_RUNTIME_IMPLEMENTATION_SOURCES = [
    "//aseipp/cs2wasm/runtime/dotnet:" + name
    for name in [
        "BigInteger.RentedBuffer.cs",
        "BigInteger.cs",
        "BigIntegerCalculator.Bitwise.cs",
        "BigIntegerCalculator.DivRem.cs",
        "BigIntegerCalculator.FastReducer.cs",
        "BigIntegerCalculator.GcdInv.cs",
        "BigIntegerCalculator.PowMod.cs",
        "BigIntegerCalculator.Shared.cs",
        "BigIntegerCalculator.ShiftRot.cs",
        "BigIntegerCalculator.SquMul.cs",
        "BigIntegerCalculator.Utils.cs",
        "Complex.Generic.cs",
        "Complex.cs",
        "DateTime.Unix.cs",
        "DateTime.cs",
        "DateTimeOffset.NonAndroid.cs",
        "DateTimeOffset.cs",
        "Half.cs",
        "Int128.cs",
        "Lazy.cs",
        "LazyOfTTMetadata.cs",
        "Matrix3x2.cs",
        "Matrix4x4.cs",
        "NumericsHelpers.cs",
        "Plane.Extensions.cs",
        "Plane.cs",
        "Quaternion.Extensions.cs",
        "Quaternion.cs",
        "Scalar.cs",
        "Stopwatch.Unix.cs",
        "Stopwatch.cs",
        "ThrowHelper.cs",
        "TimeSpan.cs",
        "UInt128.cs",
        "Vector2.Extensions.cs",
        "Vector2.cs",
        "Vector3.Extensions.cs",
        "Vector3.cs",
        "Vector4.Extensions.cs",
        "Vector4.cs",
    ]
]

# dotnet/runtime's generic-math interfaces, whose default members (the
# static virtual and default interface members) coresurface merges into the
# surface's declarations of them (docs/IMPORTER.md, "Generic math as
# built").
DOTNET_RUNTIME_INTERFACE_DEFAULTS = [
    "//aseipp/cs2wasm/runtime/dotnet:" + name + ".cs"
    for name in [
        "IAdditionOperators",
        "IBinaryInteger",
        "IBinaryNumber",
        "IDecrementOperators",
        "IDivisionOperators",
        "IExponentialFunctions",
        "IFloatingPoint",
        "IFloatingPointIeee754",
        "IIncrementOperators",
        "ILogarithmicFunctions",
        "IMultiplyOperators",
        "INumber",
        "INumberBase",
        "ISubtractionOperators",
        "ITrigonometricFunctions",
        "IUnaryNegationOperators",
    ]
]

CORELIB_SURFACE = [
    "Surface.{}.g.cs".format(name.split(":")[1].removesuffix(".cs"))
    for name in DOTNET_RUNTIME_REFERENCE_SOURCES
]

CORELIB_SOURCES = glob([
    "corelib/*.cs",
    "runtime/*.cs",
])

# The patches of dotnet/runtime's implementation sources, each a unified
# diff of the file it names, pinned beside them.
CORELIB_PATCHES = [
    "//aseipp/cs2wasm/runtime/dotnet:" + name
    for name in [
        "BigInteger.cs.patch",
        "BigIntegerCalculator.GcdInv.cs.patch",
        "BigIntegerCalculator.ShiftRot.cs.patch",
        "Matrix3x2.cs.patch",
        "Matrix4x4.cs.patch",
    ]
]

depot.csharp.binary(
    name = "coresurface",
    srcs = glob(["corelib/generator/*.cs"]),
    implicit_usings = True,
    invariant_globalization = True,
    lang_version = "14.0",
    nullable = "enable",
    warnings_as_errors = True,
    deps = ["third-party//csharp:Microsoft.CodeAnalysis.CSharp"],
)

depot.export_file(
    name = "surface.txt",
    src = "corelib/surface.txt",
)

depot.genrule(
    name = "corelib",
    srcs = CORELIB_SOURCES,
    outs = {
        name: [name]
        for name in [
            "Gameplay.CoreLib.dll",
            "Gameplay.CoreLib.pdb",
            "report.txt",
        ] + CORELIB_SURFACE
    },
    cmd = " ".join(
        [
            "$(exe :coresurface)",
            "--allow $(location :surface.txt)",
            "--out $OUT",
            "--report $OUT/report.txt",
            "--assembly $OUT/Gameplay.CoreLib.dll",
            "--pdb $OUT/Gameplay.CoreLib.pdb",
            "--source-root $SRCDIR",
            "--resx $(location //aseipp/cs2wasm/runtime/dotnet:Strings.resx)",
            "--resx $(location //aseipp/cs2wasm/runtime/dotnet:Numerics.Strings.resx)",
        ] + [
            "--ref $(location {})".format(source)
            for source in DOTNET_RUNTIME_REFERENCE_SOURCES
        ] + [
            "--impl $(location {})".format(source)
            for source in DOTNET_RUNTIME_IMPLEMENTATION_SOURCES
        ] + [
            "--defaults $(location {})".format(source)
            for source in DOTNET_RUNTIME_INTERFACE_DEFAULTS
        ] + [
            "--patch $(location {})".format(patch)
            for patch in CORELIB_PATCHES
        ] + [
            "--source $SRCDIR/" + source
            for source in CORELIB_SOURCES
        ],
    ),
    default_outs = ["Gameplay.CoreLib.dll"],
)

[
    depot.export_file(
        name = name,
        src = "tests/wit/" + name,
    )
    for name in [
        "features.wit",
        "Features.cs",
        "Bindings.g.cs",
        "echo.wit",
        "Echo.cs",
        "tasks.wit",
        "Tasks.cs",
        "sleepy.wit",
        "Sleepy.cs",
        "files.wit",
        "Files.cs",
        "ledger.wit",
        "Bank.cs",
        "Teller.cs",
    ]
]

# tests/wit: bindings generated for tests/wit/features.wit must match the
# committed Bindings.g.cs, compile together with the implementation, run
# against a host keyed by canonical ABI names, and componentize.
depot.command_test(
    name = "wit-test",
    script = """
        out=`mktemp -d`
        trap 'rm -rf "$out"' EXIT
        $(exe tilde//aseipp/witgen:witgen) csharp $(location :features.wit) --world test -o "$out/Bindings.g.cs"
        if ! cmp -s "$out/Bindings.g.cs" $(location :Bindings.g.cs); then
            echo "tests/wit/Bindings.g.cs is out of date; regenerate it:" >&2
            echo "  buck2 run tilde//aseipp/witgen:witgen -- csharp tilde/aseipp/cs2wasm/tests/wit/features.wit --world test -o tilde/aseipp/cs2wasm/tests/wit/Bindings.g.cs" >&2
            diff -u $(location :Bindings.g.cs) "$out/Bindings.g.cs" >&2 || true
            exit 1
        fi
        if $(exe tilde//aseipp/witgen:witgen) csharp $(location :features.wit) --world partial --strict -o /dev/null 2>"$out/report"; then
            echo "expected --strict to refuse world partial" >&2
            exit 1
        fi
        grep -q 'export signal' "$out/report"
        $(exe :gameplayc) -o "$out/features.wasm" $(location :Bindings.g.cs) $(location :Features.cs)
        $(exe tilde//aseipp/wlink:wlink) componentize "$out/features.wasm" --wit $(location :features.wit) --world test -o "$out/features.component.wasm"
        $(exe tilde//aseipp/witgen:witgen) csharp $(location :echo.wit) -o "$out/EchoBindings.g.cs"
        $(exe :gameplayc) -o "$out/echo.wasm" "$out/EchoBindings.g.cs" $(location :Echo.cs)
        $(exe tilde//aseipp/wlink:wlink) componentize "$out/echo.wasm" --wit $(location :echo.wit) -o "$out/echo.component.wasm"
        $(exe :wit) "$out/features.wasm" "$out/features.component.wasm" "$out/echo.component.wasm"
    """,
)

# tests/wit/tasks.wit: async functions through the component model's callback
# ABI, compiled and componentized, run by tests/wit-tasks.mjs as a
# component runtime would; sleepy.wit's and files.wit's (WASI 0.3's clock,
# filesystem and standard output, through futures and streams) linked by
# wlink and run by tests/wit-linked.mjs over wlink's async host ABI, and by
# Wasmtime when it is installed; and ledger.wit's two modules, one using the
# other's exported resource, linked together by wlink and composed for
# Wasmtime. All of them link.
depot.command_test(
    name = "wit-tasks-test",
    script = """
        out=`mktemp -d`
        trap 'rm -rf "$out"' EXIT
        $(exe tilde//aseipp/witgen:witgen) csharp $(location :tasks.wit) --strict -o "$out/TasksBindings.g.cs"
        $(exe :gameplayc) -o "$out/tasks.wasm" "$out/TasksBindings.g.cs" $(location :Tasks.cs)
        $(exe tilde//aseipp/wlink:wlink) componentize "$out/tasks.wasm" --wit $(location :tasks.wit) -o "$out/tasks.component.wasm"
        $(exe tilde//aseipp/witgen:witgen) csharp $(location :sleepy.wit) -o "$out/SleepyBindings.g.cs"
        $(exe :gameplayc) -o "$out/sleepy.wasm" "$out/SleepyBindings.g.cs" $(location :Sleepy.cs)
        $(exe tilde//aseipp/wlink:wlink) componentize "$out/sleepy.wasm" --wit $(location :sleepy.wit) -o "$out/sleepy.component.wasm"
        $(exe tilde//aseipp/witgen:witgen) csharp $(location :files.wit) --strict -o "$out/FilesBindings.g.cs"
        $(exe :gameplayc) -o "$out/files.wasm" "$out/FilesBindings.g.cs" $(location :Files.cs)
        $(exe tilde//aseipp/wlink:wlink) componentize "$out/files.wasm" --wit $(location :files.wit) -o "$out/files.component.wasm"
        for world in bank teller; do
            $(exe tilde//aseipp/witgen:witgen) csharp $(location :ledger.wit) --world $world --strict -o "$out/$world.g.cs" || exit 1
        done
        $(exe :gameplayc) -o "$out/bank.wasm" "$out/bank.g.cs" $(location :Bank.cs)
        $(exe :gameplayc) -o "$out/teller.wasm" "$out/teller.g.cs" $(location :Teller.cs)
        for world in bank teller; do
            $(exe tilde//aseipp/wlink:wlink) componentize "$out/$world.wasm" --wit $(location :ledger.wit) --world $world -o "$out/$world.component.wasm" || exit 1
        done
        $(exe :wit-tasks) "$out/tasks.wasm" "$out/tasks.component.wasm" "$out/sleepy.component.wasm" "$out/files.component.wasm" "$out/teller.component.wasm" "$out/bank.component.wasm"
        for component in tasks sleepy files; do
            $(exe tilde//aseipp/wlink:wlink) link -o "$out/$component.linked.wasm" "$out/$component.component.wasm" || exit 1
        done
        $(exe tilde//aseipp/wlink:wlink) link -o "$out/ledger.linked.wasm" "teller=$out/teller.component.wasm" "bank=$out/bank.component.wasm"
        $(exe :wit-linked) "$out/sleepy.linked.wasm" "$out/files.linked.wasm" "$out/ledger.linked.wasm"
    """,
)

# The CLR oracle for tests/differential.mjs: the fixtures compiled on the
# CLR's terms (see tests/reference/README.md), driven through reflection.
depot.csharp.binary(
    name = "reference",
    srcs = [
        "examples/HeapGameplay.cs",
        "sdk/Frames.cs",
        "sdk/Gameplay.cs",
        "tests/Anonymous.cs",
        "tests/Async.cs",
        "tests/BigIntegers.cs",
        "tests/Boxing.cs",
        "tests/Characters.cs",
        "tests/Checked.cs",
        "tests/Collections.cs",
        "tests/Combinations.cs",
        "tests/Comparers.cs",
        "tests/Complexes.cs",
        "tests/Construction.cs",
        "tests/Constructors.cs",
        "tests/Converts.cs",
        "tests/Decimals.cs",
        "tests/Delegates.cs",
        "tests/Differential.cs",
        "tests/Dispatch.cs",
        "tests/EnumMembers.cs",
        "tests/Enumerables.cs",
        "tests/Equatables.cs",
        "tests/ExceptionMessages.cs",
        "tests/Exceptions.cs",
        "tests/Features.cs",
        "tests/FieldInitializers.cs",
        "tests/Filters.cs",
        "tests/Formatting.cs",
        "tests/Framework.cs",
        "tests/GenericMath.cs",
        "tests/Generics.cs",
        "tests/IlAccepted.cs",
        "tests/IlRegressions.cs",
        "tests/Inheritance.cs",
        "tests/Initializers.cs",
        "tests/InterfaceEvents.cs",
        "tests/Interfaces.cs",
        "tests/Iterators.cs",
        "tests/Jumps.cs",
        "tests/Libraries.cs",
        "tests/Linq.cs",
        "tests/ManyTypes.cs",
        "tests/Memories.cs",
        "tests/MoreCollections.cs",
        "tests/MultiArrays.cs",
        "tests/Multicast.cs",
        "tests/Nullables.cs",
        "tests/Numerics.cs",
        "tests/Parameters.cs",
        "tests/PrimaryConstructors.cs",
        "tests/Ranges.cs",
        "tests/Records.cs",
        "tests/References.cs",
        "tests/Regressions.cs",
        "tests/Sharing.cs",
        "tests/Simd.cs",
        "tests/Sorting.cs",
        "tests/Spans.cs",
        "tests/Statements.cs",
        "tests/Strings.cs",
        "tests/Structs.cs",
        "tests/Syntax.cs",
        "tests/Text.cs",
        "tests/Time.cs",
        "tests/Transcendentals.cs",
        "tests/Tuples.cs",
        "tests/TypeInitialization.cs",
        "tests/Types.cs",
        "tests/Unions.cs",
        "tests/UnprintedRecords.cs",
        "tests/Vectors.cs",
        "tests/WideMath.cs",
        "tests/libraries/Geometry.cs",
        "tests/libraries/Shapes.cs",
        "tests/reference/Program.cs",
    ],
    assembly_name = "Gameplay.Reference",
    # The fixtures are gameplay code, which gameplayc parses as C# 15.
    lang_version = "15.0",
    nullable = "disable",
    profile = "jit",
    warnings_as_errors = True,
)

# The test scripts are written for Node; Deno's Node compatibility runs them
# unchanged. `srcs` are the modules and C# sources each one reaches. The
# scripts that drive the compiler write scratch files and run subprocesses
# with the caller's environment. The excluded lint rules are Deno's opinions
# about Node and browser code.
DENO_COMPILER_PERMISSIONS = [
    "env",
    "read",
    "run",
    "write",
]

[
    depot.deno.run(
        name = name,
        src = "tests/{}.mjs".format(name),
        srcs = srcs,
        lint_rules_exclude = [
            "no-inner-declarations",
            "no-window",
            "no-window-prefix",
        ],
        permissions = permissions,
    )
    for name, srcs, permissions in [
        (
            "behavior",
            glob([
                "tests/*.mjs",
                "tests/*.cs",
                "tests/corpus/*.cs",
                "examples/**/*.mjs",
                "examples/**/*.cs",
            ]),
            DENO_COMPILER_PERMISSIONS,
        ),
        (
            "differential",
            [
                "examples/HeapGameplay.cs",
                "tests/Async.cs",
                "tests/Boxing.cs",
                "tests/Characters.cs",
                "tests/Collections.cs",
                "tests/Combinations.cs",
                "tests/Constructors.cs",
                "tests/Delegates.cs",
                "tests/Differential.cs",
                "tests/ExceptionMessages.cs",
                "tests/Exceptions.cs",
                "tests/Features.cs",
                "tests/FieldInitializers.cs",
                "tests/Filters.cs",
                "tests/Formatting.cs",
                "tests/Framework.cs",
                "tests/GenericMath.cs",
                "tests/WideMath.cs",
                "tests/IlAccepted.cs",
                "tests/IlRegressions.cs",
                "tests/Sharing.cs",
                "tests/Simd.cs",
                "tests/Vectors.cs",
                "tests/BigIntegers.cs",
                "tests/Complexes.cs",
                "tests/Equatables.cs",
                "tests/Time.cs",
                "tests/Generics.cs",
                "tests/Inheritance.cs",
                "tests/Interfaces.cs",
                "tests/Multicast.cs",
                "tests/Records.cs",
                "tests/Strings.cs",
                "tests/Structs.cs",
                "tests/Construction.cs",
                "tests/Syntax.cs",
                "tests/Text.cs",
                "tests/Transcendentals.cs",
                "tests/Tuples.cs",
                "tests/Nullables.cs",
                "tests/Parameters.cs",
                "tests/PrimaryConstructors.cs",
                "tests/References.cs",
                "tests/Enumerables.cs",
                "tests/Iterators.cs",
                "tests/Linq.cs",
                "tests/Anonymous.cs",
                "tests/UnprintedRecords.cs",
                "tests/ManyTypes.cs",
                "tests/Converts.cs",
                "tests/Memories.cs",
                "tests/InterfaceEvents.cs",
                "tests/Decimals.cs",
                "tests/Spans.cs",
                "tests/MoreCollections.cs",
                "tests/Comparers.cs",
                "tests/MultiArrays.cs",
                "tests/EnumMembers.cs",
                "tests/Types.cs",
                "tests/Dispatch.cs",
                "tests/Numerics.cs",
                "tests/Initializers.cs",
                "tests/Regressions.cs",
                "tests/Ranges.cs",
                "tests/Checked.cs",
                "tests/Jumps.cs",
                "tests/Sorting.cs",
                "tests/Statements.cs",
                "tests/TypeInitialization.cs",
                "tests/Unions.cs",
                "tests/Libraries.cs",
                "tests/libraries/Geometry.cs",
                "tests/libraries/Shapes.cs",
            ],
            DENO_COMPILER_PERMISSIONS,
        ),
        (
            "integration",
            glob([
                "tests/*.mjs",
                "tests/*.cs",
                "tests/corpus/*.cs",
                "examples/**/*.mjs",
                "examples/**/*.cs",
            ]),
            DENO_COMPILER_PERMISSIONS,
        ),
        ("encoding", [], []),
        (
            "wit",
            [],
            [
                "env",
                "read",
                "run",
            ],
        ),
        (
            "wit-tasks",
            [],
            [
                "env",
                "read",
                "run",
                "write",
            ],
        ),
        (
            "wit-linked",
            [],
            ["read"],
        ),
    ]
]

# tests/encoding.mjs: independently hand-assembled Wasm probes.
depot.run_test(
    name = "encoding-test",
    dep = ":encoding",
)

# tests/behavior.mjs: every behavior suite and rejection case, compiled by the
# configured compiler. `$(exe)` expands to the JIT layout's whole command line.
depot.command_test(
    name = "behavior-test",
    script = "$(exe :behavior) $(exe :gameplayc)",
)

# tests/integration.mjs: every behavior suite and rejection case through the
# compiler, then Binaryen's wasm-opt optimizes each suite's module and the
# suites run again. The script's other tools (wasm-tools, Wasmtime,
# SpiderMonkey's js140 shell for tests/spidermonkey.mjs) are not in the build
# graph.
depot.command_test(
    name = "integration-test",
    script = """
        bin=`mktemp -d`
        trap 'rm -rf "$bin"' EXIT
        ln -s "$PWD/$(exe third-party//by-name/bi/binaryen:wasm-opt)" "$bin/wasm-opt"
        PATH="$bin:$PATH" $(exe :integration) --binaryen $(exe :gameplayc)
    """,
)

# tests/differential.mjs: the same C# on the CLR and in Wasm. The oracle is
# the toolchain's apphost, which finds its runtime through DOTNET_ROOT.
depot.command_test(
    name = "differential-test",
    script = """
        export DOTNET_ROOT="$PWD/$(location toolchains//csharp:dotnet)"
        export GAMEPLAYC_REFERENCE="$(location :reference)/Gameplay.Reference"
        export GAMEPLAYC_LIBRARIES="$(location :test-shapes)"
        $(exe :differential) $(exe :gameplayc)
    """,
)

# tests/libraries: gameplay libraries, Shapes over Geometry, which the
# differential test's `libraries` module (tests/Libraries.cs) references.
gameplay.library(
    name = "test-geometry",
    srcs = ["tests/libraries/Geometry.cs"],
    assembly_name = "Geometry",
)

gameplay.library(
    name = "test-shapes",
    srcs = ["tests/libraries/Shapes.cs"],
    assembly_name = "Shapes",
    deps = [":test-geometry"],
)

# tests/generator: a Roslyn source generator (`gameplay.module`'s
# `generators`, gameplayc's --generator) built by the toolchain against the
# Roslyn the compiler embeds. Probe.cs, compiled with it by gameplayc and by
# csc (the generator as an analyzer), must give the CLR's answers; its
# error, warning and exception must surface as the compiler's diagnostics.
# Kinds.cs (a library) and Built.cs (a module over it) read what the
# generator was told of each build (its build_property options).
depot.csharp.library(
    name = "probe-generator",
    srcs = ["tests/generator/DescribeGenerator.cs"],
    lang_version = "14.0",
    nullable = "enable",
    warnings_as_errors = True,
    deps = ["third-party//csharp:Microsoft.CodeAnalysis.CSharp"],
)

depot.csharp.binary(
    name = "probe-clr",
    srcs = [
        "tests/generator/Probe.cs",
        "tests/generator/Program.cs",
    ],
    analyzers = [":probe-generator"],
    lang_version = "15.0",
    nullable = "disable",
    profile = "jit",
    warnings_as_errors = True,
)

depot.deno.run(
    name = "generators",
    src = "tests/generators.mjs",
    permissions = ["read"],
)

[
    depot.export_file(
        name = name,
        src = "tests/generator/" + name,
    )
    for name in [
        "Probe.cs",
        "Misuse.cs",
        "Explode.cs",
        "Kinds.cs",
        "Built.cs",
    ]
]

depot.command_test(
    name = "generator-test",
    script = """
        out=`mktemp -d`
        trap 'rm -rf "$out"' EXIT
        export DOTNET_ROOT="$PWD/$(location toolchains//csharp:dotnet)"
        $(exe :gameplayc) --generator $(location :probe-generator) -o "$out/probe.wasm" $(location :Probe.cs)
        $(exe :probe-clr) > "$out/clr.txt"
        $(exe :generators) "$out/probe.wasm" "$out/clr.txt"
        if $(exe :gameplayc) --generator $(location :probe-generator) -o "$out/misuse.wasm" $(location :Misuse.cs) 2> "$out/misuse.txt"; then
            echo "expected PROBE001 to fail the compilation" >&2
            exit 1
        fi
        cat "$out/misuse.txt"
        grep -q "Misuse.cs(15,15): error PROBE001: 'Sealed' is marked \\[Describe\\] but is not partial" "$out/misuse.txt"
        grep -q "Misuse.cs(10,23): warning PROBE002" "$out/misuse.txt"
        if $(exe :gameplayc) --generator $(location :probe-generator) -o "$out/explode.wasm" $(location :Explode.cs) 2> "$out/explode.txt"; then
            echo "expected a throwing generator to fail the compilation" >&2
            exit 1
        fi
        cat "$out/explode.txt"
        grep -q "Generator 'Probe.Generators.DescribeGenerator' threw InvalidOperationException: asked to explode on Bomb" "$out/explode.txt"
        test ! -e "$out/misuse.wasm" && test ! -e "$out/explode.wasm"
        mkdir "$out/kinds"
        $(exe :gameplayc) --library ProbeKinds --generator $(location :probe-generator) -o "$out/kinds/ProbeKinds.dll" $(location :Kinds.cs)
        $(exe :gameplayc) --generator $(location :probe-generator) --reference "$out/kinds" -o "$out/built.wasm" $(location :Built.cs)
        $(exe :generators) --built "$out/built.wasm"
    """,
)

# The frame loop for ordinary .NET projects, for the CLR sides of tests
# elsewhere (engine/).
depot.export_file(
    name = "sdk/Frames.cs",
    src = "sdk/Frames.cs",
    visibility = ["PUBLIC"],
)

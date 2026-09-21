# SPDX-FileCopyrightText: © 2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

load("@root//buck/shims:shims.bzl", depot = "shims")

# The compiler embeds the targeting pack's System.Runtime reference assembly
# as the binding metadata it hands Roslyn (see README.md, "Pinned
# toolchain").
depot.csharp.reference_assembly(
    name = "System.Runtime.ref",
    assembly = "System.Runtime",
)

# Roslyn 5.9.0 lacks three trimming annotations Native AOT needs, and reads
# Assembly.Location for one diagnostic; build/PrepareRoslynAot.cs repairs a
# private copy with Mono.Cecil. A build-time tool: it stays JIT-compiled
# whatever profile the build asks for, so `-m aot` does not first
# AOT-compile Cecil.
depot.csharp.binary(
    name = "prepare-roslyn-aot",
    srcs = ["build/PrepareRoslynAot.cs"],
    profile = "jit",
    warnings_as_errors = True,
    deps = ["third-party//csharp:Mono.Cecil"],
)

# Only ILCompiler consumes the repaired copy; csc keeps compiling against the
# signed NuGet assembly.
depot.genrule(
    name = "Microsoft.CodeAnalysis.aot.dll",
    out = "Microsoft.CodeAnalysis.dll",
    cmd = "$(exe :prepare-roslyn-aot) $(location third-party//csharp:Microsoft.CodeAnalysis.Common) $OUT",
)

GAMEPLAYC = dict(
    srcs = glob(["src/Gameplay.Compiler/**/*.cs"]),
    aot_assembly_overrides = {"Microsoft.CodeAnalysis.dll": ":Microsoft.CodeAnalysis.aot.dll"},
    implicit_usings = True,
    invariant_globalization = True,
    lang_version = "14.0",
    nullable = "enable",
    optimization_preference = "speed",
    resources = {"Gameplay.Compiler.Binding.System.Runtime.dll": ":System.Runtime.ref"},
    trimmer_single_warn = False,
    unsafe = False,
    warnings_as_errors = True,
    deps = ["third-party//csharp:Microsoft.CodeAnalysis.CSharp"],
)

# `buck2 run tilde//aseipp/cs2wasm:gameplayc -- -o out.wasm examples/Gameplay.cs`
# follows the configuration: JIT by default, `-m aot` for the deliverable.
depot.csharp.binary(
    name = "gameplayc",
    **GAMEPLAYC
)

depot.export_file(
    name = "example.cs",
    src = "examples/Gameplay.cs",
)

# The configured compiler runs and produces a Wasm module. Backticks: `$(`
# is buck2's macro syntax inside a script attribute.
depot.command_test(
    name = "smoke",
    script = """
        $(exe :gameplayc) --info | tee /dev/stderr | grep -q '^gameplayc '
        out=`mktemp -d`
        $(exe :gameplayc) -o "$out/gameplay.wasm" $(location :example.cs)
        magic="`head -c 4 "$out/gameplay.wasm" | od -An -c | tr -d ' '`"
        test "$magic" = '\\0asm' || { echo "not a Wasm module: $magic" >&2; exit 1; }
    """,
)

# The deliverable the README describes, whatever the configuration says: the
# acceptance suite runs a bare copy of the executable with no SDK reachable,
# which only a Native AOT build survives.
depot.csharp.binary(
    name = "gameplayc-aot",
    profile = "aot",
    **GAMEPLAYC
)

depot.command_test(
    name = "info",
    script = """
        info="`$(exe :gameplayc-aot) --info`"
        printf '%s\\n' "$info"
        case "$info" in
            *"native-aot=True"*) ;;
            *) echo "expected a Native AOT compiler" >&2; exit 1 ;;
        esac
    """,
)

# The CLR oracle for the differential test: the fixtures compiled on the
# CLR's terms (see tests/reference/README.md), driven through reflection.
depot.csharp.binary(
    name = "reference",
    srcs = [
        "examples/HeapGameplay.cs",
        "tests/Constructors.cs",
        "tests/Differential.cs",
        "tests/FieldInitializers.cs",
        "tests/Syntax.cs",
        "tests/reference/Program.cs",
    ],
    assembly_name = "Gameplay.Reference",
    nullable = "disable",
    profile = "jit",
    warnings_as_errors = True,
)

# The test scripts are written for Node; Deno's Node compatibility runs them
# unchanged. They need every permission because they copy the compiler into
# a scratch directory and run it there. The excluded lint rules are Deno's
# opinions about Node and browser code.
DENO_TEST = dict(
    srcs = glob([
        "tests/*.mjs",
        "tests/*.cs",
        "examples/**",
    ]),
    lint_rules_exclude = [
        "no-inner-declarations",
        "no-window",
        "no-window-prefix",
    ],
    permissions = ["all"],
)

[
    depot.deno.run(
        name = name,
        src = "tests/{}.mjs".format(name),
        **DENO_TEST
    )
    for name in [
        "integration",
        "differential",
        "encoding",
    ]
]

# tests/integration.mjs: the native, SDK-less, end-to-end acceptance suite.
depot.run_test(
    name = "integration-test",
    args = ["$(location :gameplayc-aot)"],
    dep = ":integration",
)

# tests/encoding.mjs: independently hand-assembled Wasm probes.
depot.run_test(
    name = "encoding-test",
    dep = ":encoding",
)

# tests/differential.mjs: the same C# on the CLR and in Wasm. The oracle is
# the toolchain's apphost, which finds its runtime through DOTNET_ROOT.
depot.command_test(
    name = "differential-test",
    script = """
        export DOTNET_ROOT="$PWD/$(location toolchains//csharp:dotnet)"
        export GAMEPLAYC_REFERENCE="$(location :reference)/Gameplay.Reference"
        $(exe :differential) $(location :gameplayc-aot)
    """,
)

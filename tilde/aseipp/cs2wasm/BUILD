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

# `buck2 run tilde//aseipp/cs2wasm:gameplayc -- -o out.wasm examples/Gameplay.cs`
depot.csharp.binary(
    name = "gameplayc",
    srcs = glob(["src/Gameplay.Compiler/**/*.cs"]),
    implicit_usings = True,
    invariant_globalization = True,
    lang_version = "14.0",
    nullable = "enable",
    resources = {
        "Gameplay.Compiler.Binding.Gameplay.cs": "sdk/Gameplay.cs",
        "Gameplay.Compiler.Binding.System.Runtime.dll": ":System.Runtime.ref",
    },
    unsafe = False,
    visibility = ["PUBLIC"],
    warnings_as_errors = True,
    deps = ["third-party//csharp:Microsoft.CodeAnalysis.CSharp"],
)

# The Native AOT build of the same compiler: one self-contained executable,
# which tests/integration.mjs runs with no .NET SDK reachable. ILCompiler
# reports Roslyn's own trim warnings (IL2104, and IL3000 for its command-line
# compiler's Assembly.Location, which gameplayc never reaches).
depot.csharp.binary(
    name = "gameplayc-native",
    srcs = glob(["src/Gameplay.Compiler/**/*.cs"]),
    assembly_name = "gameplayc",
    implicit_usings = True,
    invariant_globalization = True,
    lang_version = "14.0",
    nowarn = [
        "IL2104",
        "IL3000",
    ],
    nullable = "enable",
    profile = "aot",
    resources = {
        "Gameplay.Compiler.Binding.Gameplay.cs": "sdk/Gameplay.cs",
        "Gameplay.Compiler.Binding.System.Runtime.dll": ":System.Runtime.ref",
    },
    unsafe = False,
    warnings_as_errors = True,
    deps = ["third-party//csharp:Microsoft.CodeAnalysis.CSharp"],
)

# witgen: C# bindings for a WIT world, on the same wit-parser crate wlink uses;
# wlink componentizes the modules gameplayc builds against them.
WITGEN_DEPS = [
    "third-party//rust:anyhow",
    "third-party//rust:wit-parser",
]

depot.rust_library(
    name = "witgen-lib",
    srcs = glob(
        ["witgen/src/**/*.rs"],
        exclude = ["witgen/src/main.rs"],
    ),
    crate = "witgen",
    crate_root = "witgen/src/lib.rs",
    tests = [":witgen-tests"],
    deps = WITGEN_DEPS,
)

depot.rust_binary(
    name = "witgen",
    srcs = ["witgen/src/main.rs"],
    crate_root = "witgen/src/main.rs",
    visibility = ["PUBLIC"],
    deps = [
        "third-party//by-name/mi/mimalloc:rust",
        "third-party//rust:anyhow",
        "third-party//rust:clap",
        ":witgen-lib",
    ],
)

depot.rust_test(
    name = "witgen-tests",
    srcs = glob(
        ["witgen/src/**/*.rs"],
        exclude = ["witgen/src/main.rs"],
    ),
    crate = "witgen",
    crate_root = "witgen/src/lib.rs",
    deps = ["third-party//by-name/mi/mimalloc:rust"] + WITGEN_DEPS,
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
        $(exe :witgen) csharp $(location :features.wit) --world test -o "$out/Bindings.g.cs"
        if ! cmp -s "$out/Bindings.g.cs" $(location :Bindings.g.cs); then
            echo "tests/wit/Bindings.g.cs is out of date; regenerate it:" >&2
            echo "  buck2 run tilde//aseipp/cs2wasm:witgen -- csharp tilde/aseipp/cs2wasm/tests/wit/features.wit --world test -o tilde/aseipp/cs2wasm/tests/wit/Bindings.g.cs" >&2
            diff -u $(location :Bindings.g.cs) "$out/Bindings.g.cs" >&2 || true
            exit 1
        fi
        if $(exe :witgen) csharp $(location :features.wit) --world partial --strict -o /dev/null 2>"$out/report"; then
            echo "expected --strict to refuse world partial" >&2
            exit 1
        fi
        grep -q 'export describe' "$out/report"
        grep -q 'export on-text' "$out/report"
        $(exe :gameplayc) -o "$out/features.wasm" $(location :Bindings.g.cs) $(location :Features.cs)
        $(exe tilde//aseipp/wlink:wlink) componentize "$out/features.wasm" --wit $(location :features.wit) --world test -o "$out/features.component.wasm"
        $(exe :wit) "$out/features.wasm" "$out/features.component.wasm"
    """,
)

# The CLR oracle for tests/differential.mjs: the fixtures compiled on the
# CLR's terms (see tests/reference/README.md), driven through reflection.
depot.csharp.binary(
    name = "reference",
    srcs = [
        "examples/HeapGameplay.cs",
        "sdk/Gameplay.cs",
        "tests/Constructors.cs",
        "tests/Differential.cs",
        "tests/Features.cs",
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
                "examples/**/*.mjs",
                "examples/**/*.cs",
            ]),
            DENO_COMPILER_PERMISSIONS,
        ),
        (
            "differential",
            [
                "examples/HeapGameplay.cs",
                "tests/Constructors.cs",
                "tests/Differential.cs",
                "tests/Features.cs",
                "tests/FieldInitializers.cs",
                "tests/Syntax.cs",
                "tests/compiler.mjs",
            ],
            DENO_COMPILER_PERMISSIONS,
        ),
        (
            "integration",
            glob([
                "tests/*.mjs",
                "tests/*.cs",
                "examples/**/*.mjs",
                "examples/**/*.cs",
            ]),
            DENO_COMPILER_PERMISSIONS,
        ),
        ("encoding", [], []),
        (
            "wit",
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

# tests/integration.mjs: the Native AOT deliverable, copied alone into a
# directory where no SDK is reachable, runs every behavior suite and rejection
# case; Binaryen's wasm-opt then optimizes each suite's module and the suites
# run again. The script's other tools (wasm-tools, Wasmtime, SpiderMonkey's
# js140 shell for tests/spidermonkey.mjs) are not in the build graph.
depot.command_test(
    name = "integration-test",
    script = """
        bin=`mktemp -d`
        trap 'rm -rf "$bin"' EXIT
        ln -s "$PWD/$(exe third-party//by-name/bi/binaryen:wasm-opt)" "$bin/wasm-opt"
        PATH="$bin:$PATH" $(exe :integration) $(location :gameplayc-native) --binaryen
    """,
)

# tests/differential.mjs: the same C# on the CLR and in Wasm. The oracle is
# the toolchain's apphost, which finds its runtime through DOTNET_ROOT.
depot.command_test(
    name = "differential-test",
    script = """
        export DOTNET_ROOT="$PWD/$(location toolchains//csharp:dotnet)"
        export GAMEPLAYC_REFERENCE="$(location :reference)/Gameplay.Reference"
        $(exe :differential) $(exe :gameplayc)
    """,
)

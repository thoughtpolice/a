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
    resources = {"Gameplay.Compiler.Binding.System.Runtime.dll": ":System.Runtime.ref"},
    unsafe = False,
    warnings_as_errors = True,
    deps = ["third-party//csharp:Microsoft.CodeAnalysis.CSharp"],
)

depot.export_file(
    name = "example.cs",
    src = "examples/Gameplay.cs",
)

# The compiler runs and produces a Wasm module. Backticks: `$(` is buck2's
# macro syntax inside a script attribute.
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

# The CLR oracle for tests/differential.mjs: the fixtures compiled on the
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

depot.deno.run(
    name = "encoding",
    src = "tests/encoding.mjs",
    **DENO_TEST
)

# tests/encoding.mjs: independently hand-assembled Wasm probes.
depot.run_test(
    name = "encoding-test",
    dep = ":encoding",
)

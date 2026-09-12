# SPDX-FileCopyrightText: © 2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

load("@root//buck/shims:shims.bzl", depot = "shims")

# The CLR oracle: compiles each generated program with Roslyn in process and
# runs its entries through reflection (see README.md).
depot.csharp.binary(
    name = "oracle",
    srcs = ["Oracle.cs"],
    assembly_name = "FuzzOracle",
    implicit_usings = True,
    lang_version = "14.0",
    nullable = "enable",
    profile = "jit",
    warnings_as_errors = True,
    deps = ["third-party//csharp:Microsoft.CodeAnalysis.CSharp"],
)

# The generator, the differential pipeline and the minimizer, under Deno.
depot.deno.run(
    name = "driver",
    src = "fuzz.mjs",
    srcs = [
        "features.mjs",
        "gen.mjs",
        "minimize.mjs",
        "run.mjs",
        "runner.mjs",
        "scenarios.mjs",
    ],
    permissions = [
        "read",
        "run",
        "write",
    ],
)

FUZZ_ARGS = [
    "--gameplayc",
    "$(location //aseipp/cs2wasm:gameplayc)/gameplayc",
    "--oracle",
    "$(location :oracle)/FuzzOracle",
    "--dotnet-root",
    "$(location toolchains//csharp:dotnet)",
]

# `buck2 run tilde//aseipp/cs2wasm/fuzz:fuzz -- --seeds 100000 --jobs 16 --out DIR --minimize`
depot.command(
    name = "fuzz",
    args = FUZZ_ARGS,
    dep = ":driver",
)

# A fixed set of seeds, with the features known to trip compiler bugs today
# left out (gen.mjs, KNOWN_ISSUES).
depot.run_test(
    name = "fuzz-test",
    args = FUZZ_ARGS + [
        "--test",
        "--seeds",
        "200",
        "--start",
        "1",
    ],
    dep = ":driver",
)

# The same seeds without the features over the gameplay CoreLib and the
# framework (features.mjs, LIBRARY_FEATURES): other programs of the
# language alone.
depot.run_test(
    name = "fuzz-language-test",
    args = FUZZ_ARGS + [
        "--test",
        "--seeds",
        "200",
        "--start",
        "1",
        "--without",
        "framework,variance,async,vectors,bignum",
    ],
    dep = ":driver",
)

# Async programs with their async methods and lambdas compiled as
# runtime-async methods, which the compiler splits itself
# (docs/IMPORTER.md, "Async as built").
depot.run_test(
    name = "fuzz-runtime-async-test",
    args = FUZZ_ARGS + [
        "--test",
        "--seeds",
        "100",
        "--start",
        "1",
        "--features",
        "async",
        "--compiler-flag",
        "--runtime-async",
    ],
    dep = ":driver",
)

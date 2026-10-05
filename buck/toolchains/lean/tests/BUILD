# SPDX-FileCopyrightText: © 2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

load("@root//buck/shims:shims.bzl", depot = "shims")
load("@root//src/fozzie:defs.bzl", "cxx_fuzz_binary")

# Two Lean libraries (one with its @[extern] function in C), a Lean program
# using both, proofs, and a C++ program calling into Lean.

depot.lean.library(
    name = "greeting",
    srcs = [
        "Greeting.lean",
        "Greeting/Basic.lean",
    ],
)

depot.cxx_library(
    name = "native-c",
    srcs = ["native.c"],
    deps = ["toolchains//lean:headers"],
)

# Precompiled, so :native-eval can run mulAdd while it elaborates; the
# interpreter cannot run an @[extern] function on its own.
depot.lean.library(
    name = "native",
    srcs = ["Native.lean"],
    precompile = True,
    deps = [
        ":greeting",
        ":native-c",
    ],
)

# One precompiled library whose modules run each other's native code.
depot.lean.library(
    name = "native-local",
    srcs = [
        "NativeLocal/Eval.lean",
        "NativeLocal/Ffi.lean",
    ],
    precompile = True,
    deps = [
        ":greeting",
        ":native-c",
    ],
)

depot.lean.test(
    name = "native-eval",
    srcs = ["NativeEval.lean"],
    deps = [":native"],
)

depot.lean.binary(
    name = "hello",
    srcs = ["Main.lean"],
    deps = [
        ":greeting",
        ":native",
    ],
)

# Backticks because `$(` is buck2's own macro syntax here.
depot.command_test(
    name = "hello-output",
    script = """
        out="`$(exe :hello)`"
        printf '%s\\n' "$out"
        case "$out" in
            *"hello, lean (42)"*"mulAdd 6 7 0 = 42"*) ;;
            *) echo "unexpected output" >&2; exit 1 ;;
        esac
    """,
)

# The same program as a test, which passes because it exits 0 without
# arguments.
depot.lean.test(
    name = "hello-test",
    srcs = ["Main.lean"],
    executable = True,
    deps = [
        ":greeting",
        ":native",
    ],
)

# split_codegen, kept to a program whose every module takes it, and whose
# code needs nothing from the standard library's code generator data. The
# toolchain's README says why it goes no further.
depot.lean.test(
    name = "split-codegen",
    srcs = [
        "Split/Main.lean",
        "Split/Shapes.lean",
    ],
    executable = True,
    split_codegen = True,
)

depot.lean.test(
    name = "proofs",
    srcs = ["Proofs.lean"],
    deps = [":greeting"],
)

depot.cxx_binary(
    name = "interop",
    srcs = ["interop.cpp"],
    deps = [":greeting"],
)

depot.run_test(
    name = "interop-test",
    dep = ":interop",
)

# Lean code in fuzz targets, which link with lld outside the Nix linker
# wrapper. The harness feeds :greeting arbitrary bytes.
[
    cxx_fuzz_binary(
        name = name,
        srcs = ["fuzz.cpp"],
        duration_seconds = 0,
        jobs = 1,
        runs = 256,
        sanitizer = sanitizer,
        deps = [":greeting"],
    )
    for name, sanitizer in [
        ("greeting-fuzz", "none"),
        ("greeting-fuzz-asan", "address"),
    ]
]

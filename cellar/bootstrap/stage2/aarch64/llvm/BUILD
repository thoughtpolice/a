# SPDX-FileCopyrightText: 2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

load("@cellar//bootstrap:actions.bzl", "generate", "compare_test")
load("@cellar//bootstrap:defs.bzl", "export_file", "filegroup")
load("@cellar//bootstrap:source.bzl", "write_file")
load("@cellar//bootstrap/platforms:defs.bzl", "amd64_dep")
load("@cellar//bootstrap/stage1:defs.bzl", "c_binary", "c_object")
load("@cellar//bootstrap/stage1/llvm:runtimes.bzl", "clang_compilers", "llvm_runtimes", "runtime_headers")
load(":config.bzl", "AARCH64")

X86 = "cellar//bootstrap/stage1/llvm"

# Explicit transitions share every seed-chain artifact with the x86 build,
# regardless of the target/CLI modifiers of this package's callers.
[amd64_dep(name = name, actual = X86 + ":" + name) for name in [
    "compiler-source", "runtimes-source", "headers.sh", "tests/runtimes.cc",
]]
amd64_dep(name = "bootstrap-tools", actual = X86 + ":toolchain")
amd64_dep(name = "mimalloc-source", actual = "cellar//bootstrap/stage1/mimalloc:mimalloc-3.5.3")
amd64_dep(name = "acceptance-source", actual = "cellar//bootstrap/stage1/installation:acceptance-source")

runtime_headers(config = AARCH64)

clang_compilers(
    stage = "stage0",
    tree = ":bootstrap-tools",
    archiver = X86 + ":stage3-llvm-llvm-ar",
    config = AARCH64,
    tool_cpu = "amd64",
    chdir = "cellar//bootstrap/stage0-posix/cellar-extra:chdirenv",
)

llvm_runtimes("stage0", config = AARCH64)

# Cross-built helpers are the first programs executed on the ARM platform.
# Their compiler runs on x86, so no helper depends on its own executable.
[export_file(name = name + ".c") for name in ["chdir", "capture"]]
[
    [
        c_object(
            name = name + ".o",
            src = ":" + name + ".c",
            flags = ["-std=c11", "-O2", "-Wall", "-Werror"],
            toolchain = ":stage0-cc",
            target_cpu = "arm64",
        ),
        c_binary(
            name = name,
            objects = [":" + name + ".o"],
            output = name,
            runtime = ":stage0-link-runtime",
            toolchain = ":stage0-cc",
            target_cpu = "arm64",
        ),
    ]
    for name in ["chdir", "capture"]
]

TESTS = {
    "native-c": {"sources": {"native.c": ":acceptance-source[native.c]", "helper.c": ":acceptance-source[helper.c]"}, "expected": "native C 4294967325\n"},
    "native-cxx": {"sources": {"native.cc": ":acceptance-source[native.cc]", "helper.c": ":acceptance-source[helper.c]"}, "expected": "native C++ 4294967299\n"},
    "runtimes": {"sources": {"runtimes.cc": ":tests/runtimes.cc"}, "expected": "runtimes a/c 555555555 1.5e+300\n"},
}

[
    [
        [c_object(
            name = stage + "-" + test + "-" + source,
            src = src,
            flags = ["-O2", "-pthread"] + (["-std=c++23"] if source.endswith(".cc") else []),
            object_name = source + ".o",
            toolchain = ":{}-{}".format(stage, "c++" if source.endswith(".cc") else "cc"),
            target_cpu = "arm64",
        ) for source, src in spec["sources"].items()],
        c_binary(
            name = stage + "-" + test,
            objects = [":{}-{}-{}".format(stage, test, source) for source in spec["sources"]],
            runtime = ":" + stage + "-link-runtime",
            toolchain = ":" + stage + "-c++",
            target_cpu = "arm64",
        ),
        generate(
            name = stage + "-" + test + "-output",
            capture = ":capture",
            tool = ":" + stage + "-" + test,
            target_cpu = "arm64",
        ),
        write_file(name = stage + "-" + test + "-expected", content = spec["expected"]),
        compare_test(
            name = stage + "-" + test + "-test",
            actual = ":" + stage + "-" + test + "-output",
            expected = ":" + stage + "-" + test + "-expected",
            target_cpu = "arm64",
        ),
    ]
    for stage in ["stage0"]
    for test, spec in TESTS.items()
]

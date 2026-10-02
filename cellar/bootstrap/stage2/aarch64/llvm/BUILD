# SPDX-FileCopyrightText: 2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

load("@cellar//bootstrap:actions.bzl", "command_test", "compare_test", "generate")
load("@cellar//bootstrap:defs.bzl", "export_file", "filegroup")
load("@cellar//bootstrap:source.bzl", "write_file")
load("@cellar//bootstrap/platforms:defs.bzl", "amd64_dep")
load("@cellar//bootstrap/stage1:defs.bzl", "c_binary", "c_object")
load("@cellar//bootstrap/stage1/llvm:defs.bzl", "PYTHON", "llvm_files", "llvm_stage", "resource_headers", "target_name")
load("@cellar//bootstrap/stage1/llvm:inventory.bzl", "BINARIES", BASE_LIBRARIES = "LIBRARIES")
load("@cellar//bootstrap/stage1/llvm:runtimes.bzl", "clang_compilers", "llvm_runtimes", "runtime_headers")
load(":config.bzl", "AARCH64")
load(":inventory.bzl", "DEFINES", "LIBRARIES")

X86 = "cellar//bootstrap/stage1/llvm"

# Explicit transitions share every seed-chain artifact with the x86 build,
# regardless of the target/CLI modifiers of this package's callers.
[amd64_dep(
    name = name,
    actual = X86 + ":" + name,
) for name in [
    "compiler-source",
    "runtimes-source",
    "headers.sh",
    "tests/runtimes.cc",
]]

amd64_dep(
    name = "bootstrap-tools",
    actual = X86 + ":toolchain",
)

amd64_dep(
    name = "mimalloc-source",
    actual = "cellar//bootstrap/stage1/mimalloc:mimalloc-3.5.3",
)

amd64_dep(
    name = "acceptance-source",
    actual = "cellar//bootstrap/stage1/installation:acceptance-source",
)

runtime_headers(config = AARCH64)

clang_compilers(
    archiver = X86 + ":stage3-llvm-llvm-ar",
    chdir = "cellar//bootstrap/stage0-posix/cellar-extra:chdirenv",
    config = AARCH64,
    stage = "stage0",
    tool_cpu = "amd64",
    tree = ":bootstrap-tools",
)

llvm_runtimes(
    "stage0",
    config = AARCH64,
)

llvm_files(target_cpu = "arm64")

LLVM_DEFINES = {name: '{}="{}"'.format(
    name,
    AARCH64.triple,
) for name in [
    "LLVM_HOST_TRIPLE",
    "LLVM_DEFAULT_TARGET_TRIPLE",
]}

LLVM_FLAGS = {language: [
    standard,
    "-O2",
    "-DNDEBUG",
    "-ffunction-sections",
    "-fdata-sections",
] + extra for language, standard, extra in [
    ("c", "-std=gnu11", []),
    (
        "c++",
        "-std=c++17",
        [
            "-fno-exceptions",
            "-fno-rtti",
        ],
    ),
]}

# LLD strips during the link; no architecture-specific host strip is needed.
LINK_FLAGS = [
    "--gc-sections",
    "-z",
    "stack-size=8388608",
    "--strip-all",
]

# Host generators remain x86 executables during the cross-build. The ARM
# TableGen programs this stage produces are used by the following self-build.
llvm_stage(
    defines = LLVM_DEFINES,
    flags = LLVM_FLAGS,
    generators = {name: X86 + ":stage3-" + target_name(name) for name in [
        "llvm:llvm-min-tblgen",
        "llvm:llvm-tblgen",
        "clang:clang-tblgen",
    ]},
    inventory_defines = DEFINES,
    libraries = BASE_LIBRARIES | LIBRARIES,
    link_flags = LINK_FLAGS,
    link_objects = [":stage0-mimalloc.o"],
    runtime = ":stage0-link-runtime",
    stage = "stage0",
    target_cpu = "arm64",
    toolchains = {
        "c": ":stage0-cc",
        "c++": ":stage0-c++",
    },
)

filegroup(
    name = "stage0-toolchain",
    srcs = {
        "bin/clang": ":stage0-clang-clang",
        "bin/ld.lld": ":stage0-lld-lld",
    } | resource_headers("stage0"),
)

export_file(name = "inventory.bzl")

amd64_dep(
    name = "base-inventory",
    actual = X86 + ":inventory.bzl",
)

amd64_dep(
    name = "inventory.py",
    actual = X86 + ":inventory.py",
)

command_test(
    name = "inventory-test",
    args = [
        "$(location :inventory.py)",
        "--check",
        "--cpu",
        "aarch64",
        "--compiler",
        "clang",
        "--base",
        "$(location :base-inventory)",
        "--runtimes",
        "$(location :runtimes-source)",
        "$(location :compiler-source)",
        "$(location :inventory.bzl)",
    ],
    target_cpu = "arm64",
    tool = PYTHON,
)

# Cross-built helpers are the first programs executed on the ARM platform.
# Their compiler runs on x86, so no helper depends on its own executable.
[export_file(name = name + ".c") for name in [
    "chdir",
    "capture",
]]

[
    [
        c_object(
            name = name + ".o",
            src = ":" + name + ".c",
            flags = [
                "-std=c11",
                "-O2",
                "-Wall",
                "-Werror",
            ],
            target_cpu = "arm64",
            toolchain = ":stage0-cc",
        ),
        c_binary(
            name = name,
            objects = [":" + name + ".o"],
            output = name,
            runtime = ":stage0-link-runtime",
            target_cpu = "arm64",
            toolchain = ":stage0-cc",
        ),
    ]
    for name in [
        "chdir",
        "capture",
    ]
]

TESTS = {
    "native-c": {
        "sources": {
            "native.c": ":acceptance-source[native.c]",
            "helper.c": ":acceptance-source[helper.c]",
        },
        "expected": "native C 4294967325\n",
    },
    "native-cxx": {
        "sources": {
            "native.cc": ":acceptance-source[native.cc]",
            "helper.c": ":acceptance-source[helper.c]",
        },
        "expected": "native C++ 4294967299\n",
    },
    "runtimes": {
        "sources": {"runtimes.cc": ":tests/runtimes.cc"},
        "expected": "runtimes a/c 555555555 1.5e+300\n",
    },
}

[
    [
        [c_object(
            name = stage + "-" + test + "-" + source,
            src = src,
            flags = [
                "-O2",
                "-pthread",
            ] + (["-std=c++23"] if source.endswith(".cc") else []),
            object_name = source + ".o",
            target_cpu = "arm64",
            toolchain = ":{}-{}".format(
                stage,
                "c++" if source.endswith(".cc") else "cc",
            ),
        ) for source, src in spec["sources"].items()],
        c_binary(
            name = stage + "-" + test,
            objects = [":{}-{}-{}".format(stage, test, source) for source in spec["sources"]],
            runtime = ":" + stage + "-link-runtime",
            target_cpu = "arm64",
            toolchain = ":" + stage + "-c++",
        ),
        generate(
            name = stage + "-" + test + "-output",
            capture = ":capture",
            target_cpu = "arm64",
            tool = ":" + stage + "-" + test,
        ),
        write_file(
            name = stage + "-" + test + "-expected",
            content = spec["expected"],
        ),
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

# SPDX-FileCopyrightText: 2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

load("@cellar//bootstrap:actions.bzl", "command_test", "compare_test", "generate", "result_test")
load("@cellar//bootstrap:defs.bzl", "export_file", "filegroup")
load("@cellar//bootstrap:source.bzl", "write_file")
load("@cellar//bootstrap/platforms:defs.bzl", "amd64_dep")
load("@cellar//bootstrap/stage1:defs.bzl", "c_binary", "c_object")
load("@cellar//bootstrap/stage1/llvm:defs.bzl", "PYTHON", "llvm_files", "llvm_stage", "resource_headers", "target_name")
load("@cellar//bootstrap/stage1/llvm:inventory.bzl", "BINARIES", BASE_LIBRARIES = "LIBRARIES")
load("@cellar//bootstrap/stage1/llvm:runtimes.bzl", "clang_compilers", "llvm_runtimes", "runtime_headers", "runtime_installation")
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

# Each native stage rebuilds the complete compiler and runtime closure. Tools
# inside its toolchain_dep select ARM execution, while source generators such
# as Python and sed independently retain their x86 execution dependencies.
[
    [
        clang_compilers(
            archiver = ":" + previous + "-llvm-llvm-ar",
            chdir = ":chdir",
            config = AARCH64,
            stage = stage,
            tool_cpu = "arm64",
            tree = ":" + previous + "-toolchain",
        ),
        llvm_runtimes(
            stage,
            config = AARCH64,
        ),
        llvm_stage(
            chdir = ":chdir",
            defines = LLVM_DEFINES,
            flags = LLVM_FLAGS,
            inventory_defines = DEFINES,
            libraries = BASE_LIBRARIES | LIBRARIES,
            link_flags = LINK_FLAGS,
            link_objects = [":" + stage + "-mimalloc.o"],
            runtime = ":" + stage + "-link-runtime",
            stage = stage,
            target_cpu = "arm64",
            toolchains = {
                "c": ":" + stage + "-cc",
                "c++": ":" + stage + "-c++",
            },
        ),
        filegroup(
            name = stage + "-toolchain",
            srcs = {
                "bin/clang": ":" + stage + "-clang-clang",
                "bin/ld.lld": ":" + stage + "-lld-lld",
            } | resource_headers(stage),
        ),
    ]
    for stage, previous in [
        ("stage1", "stage0"),
        ("stage2", "stage1"),
    ]
]

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
    for stage in [
        "stage0",
        "stage1",
        "stage2",
    ]
    for test, spec in TESTS.items()
]

# The third ARM build must reproduce the second before an installation can be
# published. This is a build action as well as a test, so `build ...` verifies
# the fixed point without relying on a separately invoked test sweep.
COMPARED = [target_name(name) for name in BINARIES] + sorted({
    label.removeprefix(":stage2-"): None
    for label in runtime_installation(
        "stage2",
        config = AARCH64,
    ).values()
    if label.startswith(":stage2-")
}.keys()) + ["mimalloc.o"]

export_file(name = "compare.c")

c_object(
    name = "compare.o",
    src = ":compare.c",
    flags = [
        "-std=c11",
        "-O2",
        "-Wall",
        "-Werror",
    ],
    target_cpu = "arm64",
    toolchain = ":stage0-cc",
)

c_binary(
    name = "compare",
    objects = [":compare.o"],
    runtime = ":stage0-link-runtime",
    target_cpu = "arm64",
    toolchain = ":stage0-cc",
)

generate(
    name = "fixed-point",
    args = ["$(location :{}-{})".format(stage, name) for name in COMPARED for stage in [
        "stage1",
        "stage2",
    ]],
    output = "passed",
    target_cpu = "arm64",
    tool = ":compare",
)

ALIASES = {
    "clang++": "clang",
    "llvm-ranlib": "llvm-ar",
}

amd64_dep(
    name = "alias.c",
    actual = X86 + ":alias.c",
)

[
    [
        c_object(
            name = alias + ".o",
            src = ":alias.c",
            defines = ['TARGET="{}"'.format(target)],
            flags = [
                "-std=c11",
                "-O2",
            ],
            target_cpu = "arm64",
            toolchain = ":stage2-cc",
        ),
        c_binary(
            name = alias,
            objects = [":" + alias + ".o"],
            runtime = ":stage2-link-runtime",
            target_cpu = "arm64",
            toolchain = ":stage2-cc",
        ),
    ]
    for alias, target in ALIASES.items()
]

write_file(
    name = AARCH64.triple + ".cfg",
    content = "\n".join([
        "--sysroot=<CFGDIR>/..",
        "-rtlib=compiler-rt",
        "-unwindlib=libunwind",
        "-stdlib=libc++",
        "-fuse-ld=lld",
        "-static",
    ]) + "\n",
)

filegroup(
    name = "toolchain",
    srcs = {
               "bin/clang": ":stage2-clang-clang",
               "bin/ld.lld": ":stage2-lld-lld",
               "bin/llvm-ar": ":stage2-llvm-llvm-ar",
               "bin/" + AARCH64.triple + ".cfg": ":" + AARCH64.triple + ".cfg",
               "share/bootstrap/fixed-point": ":fixed-point",
               "share/licenses/linux": AARCH64.linux + ":installation[share/licenses/linux]",
               "share/licenses/musl/COPYRIGHT": AARCH64.musl + ":source[COPYRIGHT]",
               "share/licenses/mimalloc/LICENSE": ":mimalloc-source[LICENSE]",
           } | {"bin/" + alias: ":" + alias for alias in ALIASES} |
           {"share/licenses/" + project + "/LICENSE.TXT": ":compiler-source[" + project + "/LICENSE.TXT]" for project in [
               "clang",
               "libc",
               "lld",
               "llvm",
           ]} |
           {"share/licenses/" + project + "/LICENSE.TXT": ":runtimes-source[" + project + "/LICENSE.TXT]" for project in [
               "compiler-rt",
               "libcxx",
               "libcxxabi",
               "libunwind",
           ]} |
           resource_headers("stage2") | runtime_installation(
        "stage2",
        config = AARCH64,
    ),
)

export_file(name = "toolchain-check.c")

c_object(
    name = "toolchain-check.o",
    src = ":toolchain-check.c",
    flags = [
        "-std=c11",
        "-O2",
        "-Wall",
        "-Wextra",
        "-Werror",
    ],
    target_cpu = "arm64",
    toolchain = ":stage0-cc",
)

c_binary(
    name = "toolchain-check",
    objects = [":toolchain-check.o"],
    runtime = ":stage0-link-runtime",
    target_cpu = "arm64",
    toolchain = ":stage0-cc",
)

generate(
    name = "toolchain-result",
    args = [
        "$(location :toolchain)",
        "$(location :acceptance-source)",
        "$(location :tests/runtimes.cc)",
    ],
    chdir = ":chdir",
    directory = True,
    env = {
        "PATH": "/nonexistent-bootstrap-path",
        "LC_ALL": "C",
        "TMPDIR": ".",
    },
    files = ["passed"],
    inputs = [
        ":toolchain",
        ":acceptance-source",
    ],
    target_cpu = "arm64",
    tool = ":toolchain-check",
)

result_test(
    name = "toolchain-test",
    result = ":toolchain-result[passed]",
    target_cpu = "arm64",
)

result_test(
    name = "fixed-point-test",
    result = ":fixed-point",
    target_cpu = "arm64",
)

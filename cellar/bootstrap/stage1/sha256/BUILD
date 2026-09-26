# SPDX-FileCopyrightText: 2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

load("@cellar//bootstrap:actions.bzl", "compare_test", "configured_tool", "generate", "result_test")
load("@cellar//bootstrap:defs.bzl", "filegroup", "stage0_answer_test")
load("@cellar//bootstrap/stage1:defs.bzl", "c_binary", "c_library", "c_object")

COREUTILS = "cellar//bootstrap/stage1/coreutils-final"

GCC = "cellar//bootstrap/stage1/gcc47"

BYTECMP = "cellar//bootstrap/stage0-posix/cellar-extra:bytecmp"

STAGES = [
    "stage1",
    "stage2",
    "stage3",
]

# The upstream GNU SHA256 command and its complete gnulib helper closure.
# Retain upstream library ordering, but do not pull in unrelated coreutils
# tables/generators built by the final compiler when compiling stage1.
LIB_SOURCES = [
    "close-stream",
    "closeout",
    "dup-safer",
    "error",
    "exitfail",
    "fopen-safer",
    "getopt",
    "getopt1",
    "quotearg",
    "sha256",
    "version-etc",
    "version-etc-fsf",
    "xalloc-die",
    "xmalloc",
]

HEADERS = [
    "lib/close-stream.h",
    "lib/closein.h",
    "lib/closeout.h",
    "lib/dirname.h",
    "lib/error.h",
    "lib/exitfail.h",
    "lib/fpending.h",
    "lib/getopt_int.h",
    "lib/gettext.h",
    "lib/intprops.h",
    "lib/md5.h",
    "lib/pathmax.h",
    "lib/quotearg.h",
    "lib/same-inode.h",
    "lib/sha1.h",
    "lib/sha256.h",
    "lib/sha512.h",
    "lib/stat-macros.h",
    "lib/stdio--.h",
    "lib/stdio-safer.h",
    "lib/timespec.h",
    "lib/u64.h",
    "lib/unistd-safer.h",
    "lib/unlocked-io.h",
    "lib/verify.h",
    "lib/version-etc.h",
    "lib/xalloc.h",
    "src/system.h",
]

filegroup(
    name = "source",
    srcs = {path: COREUTILS + ":coreutils-6.10[" + path + "]" for path in HEADERS + [
        "COPYING",
        "src/md5sum.c",
    ] + ["lib/" + name + ".c" for name in LIB_SOURCES]} | {
        "lib/config.h": COREUTILS + ":config.h",
        "lib/configmake.h": COREUTILS + ":configmake.h",
        "lib/fcntl.h": COREUTILS + ":header-fcntl.h",
        "lib/getopt.h": COREUTILS + ":coreutils-6.10[lib/getopt.in.h]",
        "lib/string.h": COREUTILS + ":header-string.h",
        "lib/sys/stat.h": COREUTILS + ":header-sys-stat.h",
    },
)

# Each object's source path and name, gnulib helpers first. Objects are
# numbered so that every stage compiles to the same object names.
OBJECTS = {"lib/" + name + ".c": name for name in LIB_SOURCES} | {"src/md5sum.c": "sha256sum"}

[
    c_object(
        name = stage + "-" + name + ".o",
        src = ":source[" + path + "]",
        defines = ["HAVE_CONFIG_H=1"] + (["HASH_ALGO_SHA256=1"] if name == "sha256sum" else []),
        flags = [
            "-O2",
            "-Werror=implicit-function-declaration",
        ],
        logical_includes = [
            "lib",
            "src",
        ],
        logical_source = path,
        object_name = "s" + str(i) + ".o",
        source_tree = ":source",
        toolchain = GCC + ":" + stage + "-gcc",
    )
    for stage in STAGES
    for i, (path, name) in enumerate(OBJECTS.items())
]

[[
    c_library(
        name = stage + "-libsha256.a",
        objects = [":" + stage + "-" + name + ".o" for name in LIB_SOURCES],
        output = "libsha256.a",
        toolchain = GCC + ":" + stage + "-gcc",
    ),
    c_binary(
        name = stage + "-sha256sum",
        libraries = [":" + stage + "-libsha256.a"],
        objects = [":" + stage + "-sha256sum.o"],
        output = "sha256sum",
        runtime = GCC + ":" + stage + "-link-runtime",
        toolchain = GCC + ":" + stage + "-gcc",
    ),
] for stage in STAGES]

configured_tool(
    name = "sha256sum",
    tool = ":stage3-sha256sum",
)

COMPARED = [name + ".o" for name in LIB_SOURCES + ["sha256sum"]] + [
    "libsha256.a",
    "sha256sum",
]

PAIRS = [
    ("stage1", "stage2"),
    ("stage2", "stage3"),
]

[compare_test(
    name = "compare-" + before + "-" + after + "-" + name,
    actual = ":" + before + "-" + name,
    expected = ":" + after + "-" + name,
) for before, after in PAIRS for name in COMPARED]

compare_test(
    name = "compare-delivered-sha256sum",
    actual = ":stage3-sha256sum",
    expected = COREUTILS + ":sha256sum",
)

filegroup(
    name = "test-source",
    srcs = {"compatibility.sh": "tests/compatibility.sh"},
)

[[
    generate(
        name = stage + "-compatibility-result",
        args = [
            "--noprofile",
            "--norc",
            "source/compatibility.sh",
            "$(exe :" + stage + "-sha256sum)",
            "$(exe " + COREUTILS + ":sha256sum)",
            "$(exe " + BYTECMP + ")",
            "$(exe " + COREUTILS + ":rm)",
        ] + ["$(exe :" + other + "-sha256sum)" for other in STAGES],
        chdir = True,
        directory = True,
        env = {
            "CELLAR_BOOTSTRAP_IDENTITY": "1",
            "LC_ALL": "C",
            "PATH": "/nonexistent-bootstrap-path",
        },
        files = ["passed"],
        source_tree = ":test-source",
        tool = "cellar//bootstrap/stage1/bash:bash",
    ),
    result_test(
        name = stage + "-gnu-compatibility",
        result = ":" + stage + "-compatibility-result[passed]",
    ),
] for stage in STAGES]

# Each generation also checks the stage0 seeds' golden answers, which the
# stage0 check verifies with mescc-tools-extra's sha256sum.
[stage0_answer_test(
    name = stage + "-seed-checksums",
    input = "cellar//bootstrap/stage0-posix/seeds/linux-amd64:amd64-files",
    sha256sum = ":" + stage + "-sha256sum",
) for stage in STAGES]

filegroup(
    name = "bootstrap",
    srcs = {stage + "/sha256sum": ":" + stage + "-sha256sum" for stage in STAGES},
    tests = [
        ":compare-" + before + "-" + after + "-" + name
        for before, after in PAIRS
        for name in COMPARED
    ] + [":compare-delivered-sha256sum"] + [":" + stage + "-gnu-compatibility" for stage in STAGES] + [
        ":" + stage + "-seed-checksums"
        for stage in STAGES
    ],
)

# SPDX-FileCopyrightText: 2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

load("@cellar//bootstrap:actions.bzl", "command_test", "configured_tool", "generate")
load("@cellar//bootstrap:defs.bzl", "filegroup", "stage0_answer_test")
load("@cellar//bootstrap:source.bzl", "write_file")
load("@cellar//bootstrap/stage1:defs.bzl", "c_binary", "c_library", "c_object")

COREUTILS = "cellar//bootstrap/stage1/coreutils-final"

GCC = "cellar//bootstrap/stage1/gcc47"

MUSL = "cellar//bootstrap/stage1/musl12"

CMP = "cellar//bootstrap/stage0-posix/cellar-extra:bytecmp"

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

[[c_object(
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
    source_alias = "cellar//bootstrap/stage1/tools:source-alias",
    source_tree = ":source",
    toolchain = GCC + ":" + stage + "-gcc",
) for i, (name, path) in enumerate([
    (
        name,
        "lib/" + name + ".c",
    )
    for name in LIB_SOURCES
] + [("sha256sum", "src/md5sum.c")])] for stage in STAGES]

[[
    c_library(
        name = stage + "-libsha256.a",
        objects = [":" + stage + "-" + name + ".o" for name in LIB_SOURCES],
        output = "libsha256.a",
        toolchain = GCC + ":" + stage + "-gcc",
    ),
    c_binary(
        name = stage + "-sha256sum",
        libraries = [
            ":" + stage + "-libsha256.a",
            MUSL + ":libc.a",
            GCC + ":" + stage + "-libgcc.a",
            MUSL + ":libc.a",
        ],
        objects = [
            MUSL + ":crt1.o",
            MUSL + ":crti.o",
            GCC + ":" + stage + "-crtbeginT.o",
            ":" + stage + "-sha256sum.o",
            GCC + ":" + stage + "-crtend.o",
            MUSL + ":crtn.o",
        ],
        output = "sha256sum",
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

[command_test(
    name = "compare-" + before + "-" + after + "-" + name,
    args = [
        "$(location :" + before + "-" + name + ")",
        "$(location :" + after + "-" + name + ")",
    ],
    tool = CMP,
) for before, after in [
    ("stage1", "stage2"),
    ("stage2", "stage3"),
] for name in COMPARED]

command_test(
    name = "compare-delivered-sha256sum",
    args = [
        "$(location :stage3-sha256sum)",
        "$(location " + COREUTILS + ":sha256sum)",
    ],
    tool = CMP,
)

filegroup(
    name = "test-source",
    srcs = {"compatibility.sh": "tests/compatibility.sh"},
)

write_file(
    name = "passed",
    content = "passed\n",
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
            "$(exe " + CMP + ")",
            "$(exe " + COREUTILS + ":rm)",
        ] + ["$(exe :" + other + "-sha256sum)" for other in STAGES],
        chdir = "cellar//bootstrap/stage0-posix/cellar-extra:chdirenv",
        directory = True,
        env = {
            "CELLAR_BOOTSTRAP_IDENTITY": "1",
            "LC_ALL": "C",
            "PATH": "/nonexistent-bootstrap-path",
        },
        files = ["passed"],
        source_alias = "cellar//bootstrap/stage1/tools:source-alias",
        source_tree = ":test-source",
        tool = "cellar//bootstrap/stage1/bash:bash",
    ),
    command_test(
        name = stage + "-gnu-compatibility",
        args = [
            "$(location :" + stage + "-compatibility-result[passed])",
            "$(location :passed)",
        ],
        tool = CMP,
    ),
] for stage in STAGES]

# Verify the original seed golden answers with each real GNU generation as
# well as the early mescc-tools-extra checksum program's existing tests.
[stage0_answer_test(
    name = stage + "-seed-checksums",
    chdirexec = "cellar//bootstrap/stage0-posix/cellar-extra:chdirexec",
    command = ":" + stage + "-sha256sum",
    input = "cellar//bootstrap/stage0-posix/seeds/linux-amd64:amd64-files",
    runner = "cellar//bootstrap/stage0-posix/cellar-extra:answer-test",
) for stage in STAGES]

filegroup(
    name = "bootstrap",
    srcs = {stage + "/sha256sum": ":" + stage + "-sha256sum" for stage in STAGES},
    tests = [
        ":compare-" + before + "-" + after + "-" + name
        for before, after in [
            ("stage1", "stage2"),
            ("stage2", "stage3"),
        ]
        for name in COMPARED
    ] + [":compare-delivered-sha256sum"] + [":" + stage + "-gnu-compatibility" for stage in STAGES] + [
        ":" + stage + "-seed-checksums"
        for stage in STAGES
    ],
)

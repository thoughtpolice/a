# SPDX-FileCopyrightText: 2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

load("@cellar//bootstrap:actions.bzl", "command_test", "generate")
load("@cellar//bootstrap:defs.bzl", "filegroup")
load("@cellar//bootstrap:source.bzl", "write_file")
load("@cellar//bootstrap/stage1:defs.bzl", "c_binary", "c_library", "c_object")

GCC = "cellar//bootstrap/stage1/gcc47"

MUSL = "cellar//bootstrap/stage1/musl12"

CC = GCC + ":stage3-gcc"

CRT = [
    MUSL + ":crt1.o",
    MUSL + ":crti.o",
    GCC + ":stage3-crtbeginT.o",
]

CRTN = [
    GCC + ":stage3-crtend.o",
    MUSL + ":crtn.o",
]

LIBC = [
    MUSL + ":libc.a",
    GCC + ":stage3-libgcc.a",
    MUSL + ":libc.a",
]

SOURCE = "cellar//bootstrap/stage1/tar:source"

SOURCES = [
    "arith",
    "buffer",
    "compare",
    "create",
    "delete",
    "extract",
    "incremen",
    "list",
    "mangle",
    "misc",
    "names",
    "open3",
    "rtapelib",
    "tar",
    "update",
]

LIBRARY = [
    "argmatch",
    "backupfile",
    "error",
    "getopt",
    "getopt1",
    "getversion",
    "modechange",
    "msleep",
    "xgetcwd",
    "xmalloc",
    "xstrdup",
]

GROUPS = {
    "src": SOURCES,
    "lib": LIBRARY + ["getdate"],
}

[
    c_object(
        name = group + "-" + name + ".o",
        src = SOURCE + "[" + group + "/" + name + ".c]",
        defines = ["HAVE_CONFIG_H=1"],
        flags = [
            "-O2",
            "-Werror",
        ],
        headers = [SOURCE],
        logical_includes = [
            ".",
            "lib",
            "src",
        ],
        logical_source = group + "/" + name + ".c",
        object_name = group + str(i) + ".o",
        source_alias = "cellar//bootstrap/stage1/tools:source-alias",
        source_tree = SOURCE,
        toolchain = CC,
    )
    for group, names in GROUPS.items()
    for i, name in enumerate(names)
]

c_library(
    name = "libtar.a",
    objects = [":lib-" + n + ".o" for n in LIBRARY + ["getdate"]],
    output = "libtar.a",
    toolchain = CC,
)

c_binary(
    name = "tar",
    libraries = [":libtar.a"] + LIBC,
    objects = CRT + [":src-" + n + ".o" for n in SOURCES] + CRTN,
    output = "tar",
    toolchain = CC,
)

command_test(
    name = "version",
    args = ["--version"],
    tool = ":tar",
)

filegroup(
    name = "test-headers",
    srcs = {"getdate.h": SOURCE + "[lib/getdate.h]"},
)

[
    [
        c_object(
            name = name + ".o",
            src = "cellar//bootstrap/stage1/tar:tests/" + name + ".c",
            flags = [
                "-O2",
                "-Werror",
            ],
            headers = [SOURCE],
            includes = [":test-headers"],
            toolchain = CC,
        ),
        c_binary(
            name = name,
            libraries = [":libtar.a"] + LIBC,
            objects = CRT + [":" + name + ".o"] + CRTN,
            toolchain = CC,
        ),
    ]
    for name in [
        "dates",
        "roundtrip",
    ]
]

command_test(
    name = "date-parser",
    env = {"TZ": "UTC0"},
    tool = ":dates",
)

generate(
    name = "roundtrip-work",
    args = ["$(exe :tar)"],
    chdir = "cellar//bootstrap/stage0-posix/cellar-extra:chdirenv",
    directory = True,
    env = {"TZ": "UTC0"},
    files = ["passed"],
    tool = ":roundtrip",
)

write_file(
    name = "expected",
    content = "passed\n",
)

command_test(
    name = "archive-roundtrip",
    args = [
        "$(location :roundtrip-work[passed])",
        "$(location :expected)",
    ],
    tool = "cellar//bootstrap/stage0-posix/cellar-extra:bytecmp",
)

filegroup(
    name = "installation",
    srcs = {
        "bin/tar": ":tar",
        "share/licenses/tar/COPYING": SOURCE + "[COPYING]",
    },
)

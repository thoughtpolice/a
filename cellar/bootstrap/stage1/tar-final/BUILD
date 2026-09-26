# SPDX-FileCopyrightText: 2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

load("@cellar//bootstrap:actions.bzl", "command_test", "generate", "result_test")
load("@cellar//bootstrap:defs.bzl", "filegroup")
load("@cellar//bootstrap/stage1:defs.bzl", "c_binary", "c_library", "c_object")

GCC = "cellar//bootstrap/stage1/gcc47"

CC = GCC + ":stage3-gcc"

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
    libraries = [":libtar.a"],
    objects = [":src-" + n + ".o" for n in SOURCES],
    output = "tar",
    runtime = GCC + ":stage3-link-runtime",
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
            libraries = [":libtar.a"],
            objects = [":" + name + ".o"],
            runtime = GCC + ":stage3-link-runtime",
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
    chdir = True,
    directory = True,
    env = {"TZ": "UTC0"},
    files = ["passed"],
    tool = ":roundtrip",
)

result_test(
    name = "archive-roundtrip",
    result = ":roundtrip-work[passed]",
)

filegroup(
    name = "installation",
    srcs = {
        "bin/tar": ":tar",
        "share/licenses/tar/COPYING": SOURCE + "[COPYING]",
    },
)

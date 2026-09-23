# SPDX-FileCopyrightText: 2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

load("@cellar//bootstrap:actions.bzl", "command_test", "configured_tool", "generate")
load("@cellar//bootstrap:defs.bzl", "export_file", "filegroup")
load("@cellar//bootstrap:source.bzl", "download_file", "exact_patch", "untar", "write_file")
load("@cellar//bootstrap/stage1:defs.bzl", "c_binary", "c_object")

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

PROGRAMS = {
    "diff": [
        "diff",
        "analyze",
        "cmpbuf",
        "dir",
        "io",
        "util",
        "context",
        "ed",
        "ifdef",
        "normal",
        "side",
        "fnmatch",
        "getopt",
        "getopt1",
        "regex",
        "version",
    ],
    "diff3": [
        "diff3",
        "getopt",
        "getopt1",
        "version",
    ],
    "sdiff": [
        "sdiff",
        "getopt",
        "getopt1",
        "version",
    ],
    "cmp": [
        "cmp",
        "cmpbuf",
        "error",
        "getopt",
        "getopt1",
        "xmalloc",
        "version",
    ],
}

FILES = [
    "analyze.c",
    "cmp.c",
    "cmpbuf.c",
    "context.c",
    "diff.c",
    "diff3.c",
    "dir.c",
    "ed.c",
    "error.c",
    "fnmatch.c",
    "getopt.c",
    "getopt1.c",
    "ifdef.c",
    "io.c",
    "normal.c",
    "regex.c",
    "sdiff.c",
    "side.c",
    "util.c",
    "version.c",
    "xmalloc.c",
    "system.h",
    "diff.h",
    "cmpbuf.h",
    "regex.h",
    "getopt.h",
    "fnmatch.h",
    "COPYING",
]

CONFIG_ON = [
    "HAVE_ALLOCA_H",
    "HAVE_ST_BLKSIZE",
    "HAVE_VPRINTF",
    "STDC_HEADERS",
    "HAVE_SYS_WAIT_H",
    "HAVE_DUP2",
    "HAVE_MEMCHR",
    "HAVE_SIGACTION",
    "HAVE_STRCHR",
    "HAVE_STRERROR",
    "HAVE_DIRENT_H",
    "HAVE_FCNTL_H",
    "HAVE_LIMITS_H",
    "HAVE_STDLIB_H",
    "HAVE_STRING_H",
    "HAVE_SYS_FILE_H",
    "HAVE_TIME_H",
    "HAVE_UNISTD_H",
]

CONFIG_VALUES = {
    "_GNU_SOURCE": "",
    "RETSIGTYPE": "void",
    "STACK_DIRECTION": "-1",
}

write_file(
    name = "config.h",
    content = "\n".join(["#define " + name + " 1" for name in CONFIG_ON]) + "\n" + "\n".join(["#define " + name + " " + value for name, value in CONFIG_VALUES.items()]) + "\n",
)

download_file(
    name = "diffutils-2.7.tar.gz",
    hash = "d5f2489c4056a31528e3ada4adacc23d498532b0af1a980f2f76158162b139d6",
    size_bytes = 312312,
    urls = ["https://mirrors.kernel.org/gnu/diffutils/diffutils-2.7.tar.gz"],
)

generate(
    name = "diffutils.tar",
    args = [
        "-dc",
        "$(location :diffutils-2.7.tar.gz)",
    ],
    capture = "cellar//bootstrap/stage1/tools:capture",
    tool = "cellar//bootstrap/stage1/gzip:gzip",
)

untar(
    name = "diffutils-2.7",
    chdirenv = "cellar//bootstrap/stage0-posix/cellar-extra:chdirenv",
    files = FILES,
    flags = [
        "--numeric-owner",
        "-xf",
    ],
    input = ":diffutils.tar",
    untar = "cellar//bootstrap/stage1/tar:tar",
)

[export_file(name = path) for path in glob([
    "patches/*",
    "tests/*",
])]

[exact_patch(
    name = name + ".c",
    src = ":diffutils-2.7[" + name + ".c]",
    patch = ":patches/" + name + ".patch",
) for name in [
    "diff3",
    "util",
]]

exact_patch(
    name = "regex-push",
    src = ":diffutils-2.7[regex.c]",
    patch = ":patches/regex-push.patch",
)

exact_patch(
    name = "regex-high",
    src = ":regex-push",
    patch = ":patches/regex-high.patch",
)

exact_patch(
    name = "regex-low",
    src = ":regex-high",
    patch = ":patches/regex-low.patch",
)

exact_patch(
    name = "regex-compare",
    src = ":regex-low",
    patch = ":patches/regex-compare.patch",
)

filegroup(
    name = "source",
    srcs = {path: ":diffutils-2.7[" + path + "]" for path in FILES} | {
        "config.h": ":config.h",
        "diff3.c": ":diff3.c",
        "util.c": ":util.c",
        "regex.c": ":regex-compare",
    },
)

[c_object(
    name = path + ".o",
    src = ":source[" + path + "]",
    defines = [
        "HAVE_CONFIG_H=1",
        'NULL_DEVICE="/dev/null"',
        'DIFF_PROGRAM="diff"',
        'PR_PROGRAM="pr"',
        'DEFAULT_EDITOR_PROGRAM="ed"',
    ],
    flags = [
        "-O2",
        "-Werror",
    ] + ([
        "-include",
        "string.h",
    ] if path == "getopt.c" else []) + ([
        "-include",
        "stdint.h",
    ] if path == "regex.c" else []),
    logical_includes = ["."],
    logical_source = path,
    object_name = "df" + str(i) + ".o",
    source_alias = "cellar//bootstrap/stage1/tools:source-alias",
    source_tree = ":source",
    toolchain = CC,
) for i, path in enumerate([path for path in FILES if path.endswith(".c")])]

[c_binary(
    name = name + "-bin",
    end_objects = CRTN,
    libraries = LIBC,
    objects = CRT + [":" + obj + ".c.o" for obj in objects],
    output = name,
    toolchain = CC,
) for name, objects in PROGRAMS.items()]

filegroup(
    name = "helpers",
    srcs = {"diff": ":diff-bin"},
)

[configured_tool(
    name = name,
    env = {"PATH": "$(location :helpers)"} if name in [
        "diff3",
        "sdiff",
    ] else {},
    env_tool = "cellar//bootstrap/stage1/tools:withenv",
    tool = ":" + name + "-bin",
) for name in PROGRAMS]

filegroup(
    name = "installation",
    srcs = {"bin/" + name: ":" + name + "-bin" for name in PROGRAMS} | {"share/licenses/diffutils/COPYING": ":source[COPYING]"},
)

[command_test(
    name = name + "-version",
    args = ["--version"],
    tool = ":" + name,
) for name in PROGRAMS]

filegroup(
    name = "test-source",
    srcs = {name: "tests/" + name for name in [
        "integration.sh",
        "base",
        "left",
        "right",
        "merged",
        "unified",
    ]},
)

generate(
    name = "integration",
    args = [
        "--noprofile",
        "--norc",
        "source/integration.sh",
        "$(exe :diff-bin)",
        "$(exe :cmp-bin)",
        "$(exe :diff3-bin)",
        "$(exe :sdiff-bin)",
    ],
    chdir = "cellar//bootstrap/stage0-posix/cellar-extra:chdirenv",
    directory = True,
    env = {
        "PATH": "$(location :helpers)",
        "CELLAR_BOOTSTRAP_IDENTITY": "1",
        "TMPDIR": ".",
        "TZ": "UTC0",
        "LC_ALL": "C",
    },
    files = ["passed"],
    source_alias = "cellar//bootstrap/stage1/tools:source-alias",
    source_tree = ":test-source",
    tool = "cellar//bootstrap/stage1/bash:bash",
)

write_file(
    name = "passed",
    content = "passed\n",
)

command_test(
    name = "comparison-and-merging",
    args = [
        "$(location :integration[passed])",
        "$(location :passed)",
    ],
    tool = "cellar//bootstrap/stage0-posix/cellar-extra:bytecmp",
)

filegroup(
    name = "empty-helpers",
    srcs = {},
)

command_test(
    name = "missing-declared-diff",
    args = [
        "2",
        "$(exe :diff3-bin)",
        "$(location :test-source[left])",
        "$(location :test-source[base])",
        "$(location :test-source[right])",
    ],
    env = {"PATH": "$(location :empty-helpers)"},
    tool = "cellar//bootstrap/stage1/tools:expect-exit",
)

# SPDX-FileCopyrightText: 2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

load("@cellar//bootstrap:actions.bzl", "command_test", "configured_tool", "generate")
load("@cellar//bootstrap:defs.bzl", "filegroup")
load("@cellar//bootstrap:source.bzl", "exact_patch", "write_file")
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

SOURCES = [
    "array",
    "builtin",
    "eval",
    "field",
    "gawkmisc",
    "io",
    "main",
    "missing",
    "msg",
    "node",
    "re",
    "version",
    "getopt",
    "getopt1",
    "regex",
    "dfa",
    "random",
]

FILES = [
    "array.c",
    "builtin.c",
    "eval.c",
    "field.c",
    "gawkmisc.c",
    "io.c",
    "main.c",
    "missing.c",
    "msg.c",
    "node.c",
    "re.c",
    "version.c",
    "getopt.c",
    "getopt1.c",
    "regex.c",
    "dfa.c",
    "random.c",
    "dfa.h",
    "regex.h",
    "patchlevel.h",
    "getopt.h",
    "acconfig.h",
    "protos.h",
    "random.h",
    "custom.h",
    "awk.h",
    "posix/gawkmisc.c",
    "awk.y",
    "COPYING",
    "awklib/eg/lib/assert.awk",
    "awklib/eg/lib/ctime.awk",
    "awklib/eg/lib/ftrans.awk",
    "awklib/eg/lib/getopt.awk",
    "awklib/eg/lib/gettime.awk",
    "awklib/eg/lib/join.awk",
    "awklib/eg/lib/mktime.awk",
    "awklib/eg/lib/nextfile.awk",
    "awklib/eg/lib/ord.awk",
    "awklib/eg/lib/round.awk",
]

DATA = [
    "assert.awk",
    "ctime.awk",
    "ftrans.awk",
    "getopt.awk",
    "gettime.awk",
    "join.awk",
    "mktime.awk",
    "nextfile.awk",
    "ord.awk",
    "round.awk",
]

# Native Linux/x86_64 with musl's libc/math and GCC builtins.
CONFIG_ON = [
    "HAVE_ALLOCA",
    "HAVE_ALLOCA_H",
    "GETPGRP_VOID",
    "HAVE_MMAP",
    "HAVE_ST_BLKSIZE",
    "HAVE_SYS_WAIT_H",
    "HAVE_TM_ZONE",
    "HAVE_TZNAME",
    "HAVE_VPRINTF",
    "STDC_HEADERS",
    "TIME_WITH_SYS_TIME",
    "HAVE_STRINGIZE",
    "REGEX_MALLOC",
    "BITOPS",
    "HAVE_FMOD",
    "HAVE_GETPAGESIZE",
    "HAVE_MADVISE",
    "HAVE_MEMCMP",
    "HAVE_MEMCPY",
    "HAVE_MEMSET",
    "HAVE_SETLOCALE",
    "HAVE_STRCHR",
    "HAVE_STRERROR",
    "HAVE_STRFTIME",
    "HAVE_STRNCASECMP",
    "HAVE_STRTOD",
    "HAVE_SYSTEM",
    "HAVE_TZSET",
    "HAVE_LIMITS_H",
    "HAVE_LOCALE_H",
    "HAVE_MEMORY_H",
    "HAVE_STDARG_H",
    "HAVE_STRING_H",
    "HAVE_STRINGS_H",
    "HAVE_SYS_PARAM_H",
    "HAVE_UNISTD_H",
]

CONFIG_VALUES = {
    "GETGROUPS_T": "gid_t",
    "RETSIGTYPE": "void",
    "SPRINTF_RET": "int",
    "DEFPATH": "\"/bootstrap/share/awk\"",
}

write_file(
    name = "config.h",
    content = "#ifndef _GNU_SOURCE\n#define _GNU_SOURCE 1\n#endif\n" + "\n".join(["#define " + name + " 1" for name in CONFIG_ON]) + "\n" + "\n".join(["#define " + name + " " + value for name, value in CONFIG_VALUES.items()]) + '\n#include "custom.h"\n',
)

filegroup(
    name = "source",
    srcs = {path: "cellar//bootstrap/stage1/gawk:source[" + path + "]" for path in FILES} | {
        "config.h": ":config.h",
        "io.c": ":io-source",
    },
)

exact_patch(
    name = "io-source",
    src = "cellar//bootstrap/stage1/gawk:io-source",
    after = 'if (!shell) shell = "/bin/sh";\n\tif (!*shell)',
    before = "if (!shell || !*shell)",
)

filegroup(
    name = "data",
    srcs = {name: ":source[awklib/eg/lib/" + name + "]" for name in DATA},
)

generate(
    name = "parser",
    args = [
        "--no-lines",
        "-o",
        "awktab.c",
        "source/awk.y",
    ],
    chdir = "cellar//bootstrap/stage0-posix/cellar-extra:chdirenv",
    directory = True,
    env = {"TMPDIR": "."},
    files = ["awktab.c"],
    source_alias = "cellar//bootstrap/stage1/tools:source-alias",
    source_tree = ":source",
    tool = "cellar//bootstrap/stage1/bison:bison",
)

filegroup(
    name = "compile-source",
    srcs = {p: ":source[" + p + "]" for p in FILES + ["config.h"]} | {"awktab.c": ":parser[awktab.c]"},
)

[
    c_object(
        name = name + ".o",
        src = ":compile-source[" + name + ".c]",
        defines = [
            "HAVE_CONFIG_H=1",
            "GAWK=1",
        ] + (["system=bootstrap_system"] if name == "builtin" else []) + (["popen=bootstrap_popen"] if name == "io" else []),
        flags = [
            "-O2",
            "-Werror",
        ] + ([
            "-include",
            "string.h",
        ] if name == "getopt" else []),
        logical_includes = ["."],
        logical_source = name + ".c",
        object_name = "g{}.o".format(i),
        source_alias = "cellar//bootstrap/stage1/tools:source-alias",
        source_tree = ":compile-source",
        toolchain = CC,
    )
    for i, name in enumerate(SOURCES + ["awktab"])
]

c_binary(
    name = "gawk-bin",
    libraries = ["cellar//bootstrap/stage1/tools-final:libshell.a"] + LIBC,
    objects = CRT + [":" + name + ".o" for name in SOURCES + ["awktab"]] + [
        GCC + ":stage3-crtend.o",
        MUSL + ":crtn.o",
    ],
    output = "gawk",
    toolchain = CC,
)

configured_tool(
    name = "gawk",
    env = {
        "CELLAR_BOOTSTRAP_IDENTITY": "1",
        "BOOTSTRAP_SHELL": "$(exe cellar//bootstrap/stage1/bash:bash)",
        "AWKPATH": "$(location :data)",
    },
    env_tool = "cellar//bootstrap/stage1/tools:withenv",
    tool = ":gawk-bin",
)

command_test(
    name = "version",
    args = ["--version"],
    tool = ":gawk",
)

configured_tool(
    name = "capture-gawk",
    args = [
        "result",
        "$(exe :gawk-bin)",
    ],
    env = {
        "CELLAR_BOOTSTRAP_IDENTITY": "1",
        "BOOTSTRAP_SHELL": "$(exe cellar//bootstrap/stage1/bash:bash)",
        "AWKPATH": "$(location :data)",
    },
    env_tool = "cellar//bootstrap/stage1/tools:withenv",
    tool = "cellar//bootstrap/stage1/tools:capture",
)

[
    [
        generate(
            name = name + "-output",
            args = extra + [
                "-f",
                "$(location cellar//bootstrap/stage1/gawk:tests/" + name + ".awk)",
            ] + (["$(location cellar//bootstrap/stage1/gawk:tests/records)"] if name == "fields" else []),
            chdir = "cellar//bootstrap/stage0-posix/cellar-extra:chdirenv",
            directory = True,
            env = {
                "TMPDIR": ".",
                "TZ": "UTC0",
                "LC_ALL": "C",
                "PATH": "/nonexistent-bootstrap-tools",
            },
            files = ["result"],
            tool = ":capture-gawk",
        ),
        command_test(
            name = name,
            args = [
                "$(location :" + name + "-output[result])",
                "$(location cellar//bootstrap/stage1/gawk:tests/" + name + ".expected)",
            ],
            tool = "cellar//bootstrap/stage0-posix/cellar-extra:bytecmp",
        ),
    ]
    for name, extra in [
        ("fields", []),
        ("language", []),
        ("math", []),
        ("io", []),
        (
            "library",
            [
                "-f",
                "join.awk",
            ],
        ),
    ]
]

command_test(
    name = "diagnostic",
    args = [
        "2",
        "$(exe :gawk-bin)",
        "BEGIN { x = /(/ }",
    ],
    tool = "cellar//bootstrap/stage1/tools:expect-exit",
)

command_test(
    name = "missing-shell",
    args = [
        "2",
        "$(exe :gawk-bin)",
        'BEGIN { "printf host" | getline x }',
    ],
    env = {
        "CELLAR_BOOTSTRAP_IDENTITY": "1",
        "BOOTSTRAP_SHELL": "",
    },
    tool = "cellar//bootstrap/stage1/tools:expect-exit",
)

filegroup(
    name = "installation",
    srcs = {
        "bin/gawk": ":gawk-bin",
        "bin/awk": ":gawk-bin",
        "share/licenses/gawk/COPYING": ":source[COPYING]",
        "share/licenses/gawk/musl-COPYRIGHT": MUSL + ":source[COPYRIGHT]",
    } | {"share/awk/" + n: ":data[" + n + "]" for n in DATA},
)

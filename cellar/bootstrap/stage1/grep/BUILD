# SPDX-FileCopyrightText: 2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

load("@cellar//bootstrap:actions.bzl", "command_test", "generate")
load("@cellar//bootstrap:defs.bzl", "filegroup")
load("@cellar//bootstrap:source.bzl", "download_file", "untar", "write_file")
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

BASE = [
    "grep",
    "dfa",
    "kwset",
    "obstack",
    "regex",
    "savedir",
    "getopt",
    "getopt1",
    "search",
]

PROGRAMS = [
    "grep",
    "egrep",
    "fgrep",
]

HEADERS = [
    "grep.h",
    "dfa.h",
    "kwset.h",
    "obstack.h",
    "regex.h",
    "savedir.h",
    "getopt.h",
    "getpagesize.h",
    "system.h",
]

FILES = ["src/" + name + ".c" for name in BASE + [name + "mat" for name in PROGRAMS]] + ["src/" + path for path in HEADERS] + ["COPYING"]

# Native LP64 interfaces and GNU regex; no translated message catalogs.
CONFIG_ON = [
    "GREP",
    "STDC_HEADERS",
    "PROTOTYPES",
    "HAVE_ALLOCA",
    "HAVE_ALLOCA_H",
    "HAVE_MMAP",
    "HAVE_BTOWC",
    "HAVE_GETCWD",
    "HAVE_GETPAGESIZE",
    "HAVE_ISASCII",
    "HAVE_MEMCHR",
    "HAVE_MEMMOVE",
    "HAVE_MUNMAP",
    "HAVE_PUTENV",
    "HAVE_SETENV",
    "HAVE_SETLOCALE",
    "HAVE_STPCPY",
    "HAVE_STRCASECMP",
    "HAVE_STRCHR",
    "HAVE_STRDUP",
    "HAVE_STRERROR",
    "HAVE_WCTYPE",
    "HAVE_DIRENT_H",
    "HAVE_LIMITS_H",
    "HAVE_LOCALE_H",
    "HAVE_MALLOC_H",
    "HAVE_MEMORY_H",
    "HAVE_NL_TYPES_H",
    "HAVE_STDLIB_H",
    "HAVE_STRING_H",
    "HAVE_SYS_PARAM_H",
    "HAVE_UNISTD_H",
    "HAVE_WCHAR_H",
    "HAVE_WCTYPE_H",
]

CONFIG_VALUES = {
    "_GNU_SOURCE": "",
    "PACKAGE": '"grep"',
    "VERSION": '"2.4"',
    "LOCALEDIR": '"/nonexistent-bootstrap-locale"',
    "STACK_DIRECTION": "-1",
}

write_file(
    name = "config.h",
    content = "\n".join(["#define " + name + " 1" for name in CONFIG_ON]) + "\n" + "\n".join(["#define " + name + " " + value for name, value in CONFIG_VALUES.items()]) + "\n",
)

download_file(
    name = "grep-2.4.tar.gz",
    hash = "a32032bab36208509466654df12f507600dfe0313feebbcd218c32a70bf72a16",
    size_bytes = 419724,
    urls = ["https://mirrors.kernel.org/gnu/grep/grep-2.4.tar.gz"],
)

generate(
    name = "grep.tar",
    args = [
        "-dc",
        "$(location :grep-2.4.tar.gz)",
    ],
    capture = "cellar//bootstrap/stage1/tools:capture",
    tool = "cellar//bootstrap/stage1/gzip:gzip",
)

untar(
    name = "grep-2.4",
    chdirenv = "cellar//bootstrap/stage0-posix/cellar-extra:chdirenv",
    files = FILES,
    flags = [
        "--numeric-owner",
        "-xf",
    ],
    input = ":grep.tar",
    untar = "cellar//bootstrap/stage1/tar:tar",
)

filegroup(
    name = "source",
    srcs = {path: ":grep-2.4[" + path + "]" for path in FILES} | {"config.h": ":config.h"},
)

[c_object(
    name = name + ".o",
    src = ":source[src/" + name + ".c]",
    defines = ["HAVE_CONFIG_H=1"],
    flags = [
        "-O2",
        "-Werror",
    ] + ([
        "-include",
        "string.h",
    ] if name == "getopt" else []),
    logical_includes = [
        ".",
        "src",
    ],
    logical_source = "src/" + name + ".c",
    object_name = "gr" + str(i) + ".o",
    source_alias = "cellar//bootstrap/stage1/tools:source-alias",
    source_tree = ":source",
    toolchain = CC,
) for i, name in enumerate(BASE + [name + "mat" for name in PROGRAMS])]

c_library(
    name = "libgrep.a",
    objects = [":" + name + ".o" for name in BASE],
    output = "libgrep.a",
    toolchain = CC,
)

[c_binary(
    name = name,
    libraries = [":libgrep.a"] + LIBC,
    objects = CRT + [":" + name + "mat.o"] + CRTN,
    output = name,
    toolchain = CC,
) for name in PROGRAMS]

filegroup(
    name = "installation",
    srcs = {"bin/" + name: ":" + name for name in PROGRAMS} | {"share/licenses/grep/COPYING": ":source[COPYING]"},
)

[command_test(
    name = name + "-version",
    args = ["--version"],
    tool = ":" + name,
) for name in PROGRAMS]

write_file(
    name = "input",
    content = "alpha 123\nbeta 42\nAlpha 7\nfoofoo\na+b\nend\n",
)

[
    [
        generate(
            name = name + "-output",
            args = args + ["$(location :input)"],
            capture = "cellar//bootstrap/stage1/tools:capture",
            env = {"LC_ALL": "C.UTF-8"},
            tool = ":" + tool,
        ),
        write_file(
            name = name + "-expected",
            content = expected,
        ),
        command_test(
            name = name,
            args = [
                "$(location :" + name + "-output)",
                "$(location :" + name + "-expected)",
            ],
            tool = "cellar//bootstrap/stage0-posix/cellar-extra:bytecmp",
        ),
    ]
    for name, tool, args, expected in [
        (
            "basic-backreference",
            "grep",
            [r"^\(foo\)\1$"],
            "foofoo\n",
        ),
        (
            "extended-regex",
            "egrep",
            ["^(alpha|beta) [[:digit:]]+$"],
            "alpha 123\nbeta 42\n",
        ),
        (
            "fixed-string",
            "fgrep",
            ["a+b"],
            "a+b\n",
        ),
        (
            "case-and-line-numbers",
            "grep",
            [
                "-in",
                "alpha",
            ],
            "1:alpha 123\n3:Alpha 7\n",
        ),
        (
            "multiple-patterns",
            "grep",
            [
                "-e",
                "^beta",
                "-e",
                "^end",
            ],
            "beta 42\nend\n",
        ),
        (
            "context",
            "grep",
            [
                "-B1",
                "-A1",
                "^foofoo",
            ],
            "Alpha 7\nfoofoo\na+b\n",
        ),
    ]
]

[command_test(
    name = name,
    args = [
        status,
        "$(location :grep)",
        pattern,
        "$(location :input)",
    ],
    tool = "cellar//bootstrap/stage1/tools:expect-exit",
) for name, pattern, status in [
    ("no-match-status", "absent", "1"),
    ("malformed-pattern", "[", "2"),
]]

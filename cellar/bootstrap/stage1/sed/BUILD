# SPDX-FileCopyrightText: © 2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

load("@cellar//bootstrap:actions.bzl", "command_test", "compare_test", "generate")
load("@cellar//bootstrap:defs.bzl", "filegroup")
load("@cellar//bootstrap:source.bzl", "download_file", "ungz", "untar", "write_file")
load("@cellar//bootstrap/stage1:defs.bzl", "c_binary", "c_library", "c_object")
load("@cellar//bootstrap/stage1/tcc:defs.bzl", "tcc_toolchain")

download_file(
    name = "sed-4.0.9.tar.gz",
    hash = "c365874794187f8444e5d22998cd5888ffa47f36def4b77517a808dec27c0600",
    urls = ["https://mirrors.kernel.org/gnu/sed/sed-4.0.9.tar.gz"],
)

ungz(
    name = "sed.tar",
    input = ":sed-4.0.9.tar.gz",
    ungz = "cellar//bootstrap/stage0-posix/mescc-tools-extra:ungz",
)

LIB_SOURCES = ["lib/" + name + ".c" for name in [
    "getline",
    "getopt1",
    "getopt",
    "utils",
    "regex",
    "obstack",
    "strverscmp",
    "mkstemp",
]]

SED_SOURCES = ["sed/" + name + ".c" for name in [
    "compile",
    "execute",
    "regexp",
    "fmt",
    "sed",
]]

FILES = LIB_SOURCES + SED_SOURCES + [
    "COPYING",
    "basicdefs.h",
    "sed/sed.h",
    "lib/getopt.h",
    "lib/utils.h",
    "lib/regex_.h",
    "lib/regex_internal.h",
    "lib/regex_internal.c",
    "lib/regcomp.c",
    "lib/regexec.c",
    "lib/obstack.h",
    "lib/strverscmp.h",
]

untar(
    name = "sed-4.0.9",
    files = FILES,
    input = ":sed.tar",
    untar = "cellar//bootstrap/stage0-posix/mescc-tools-extra:untar",
)

# Native configuration for TCC and Mes libc. Sed runs musl's header generators
# in the C locale, without multibyte conversion or message catalogs.
CONFIG = {
    "ENABLE_NLS": "0",
    "HAVE_ALLOCA": "1",
    "HAVE_ALLOCA_H": "1",
    "HAVE_ERRNO_H": "1",
    "HAVE_FCNTL_H": "1",
    "HAVE_GETCWD": "1",
    "HAVE_ISASCII": "1",
    "HAVE_ISATTY": "1",
    "HAVE_LIMITS_H": "1",
    "HAVE_MEMCHR": "1",
    "HAVE_MEMCMP": "1",
    "HAVE_MEMCPY": "1",
    "HAVE_MEMMOVE": "1",
    "HAVE_MEMSET": "1",
    "HAVE_STDARG_H": "1",
    "HAVE_STDDEF_H": "1",
    "HAVE_STDINT_H": "1",
    "HAVE_STDLIB_H": "1",
    "HAVE_STRCHR": "1",
    "HAVE_STRDUP": "1",
    "HAVE_STRERROR": "1",
    "HAVE_STRING_H": "1",
    "HAVE_STRTOUL": "1",
    "HAVE_SYS_STAT_H": "1",
    "HAVE_SYS_TYPES_H": "1",
    "HAVE_UNISTD_H": "1",
    "HAVE_VPRINTF": "1",
    "PACKAGE": '"sed"',
    "SED_FEATURE_VERSION": '"4.0"',
    "STDC_HEADERS": "1",
    "VERSION": '"4.0.9"',
}

write_file(
    name = "config.h",
    content = "".join(["#define {} {}\n".format(key, value) for key, value in CONFIG.items()]),
)

filegroup(
    name = "source",
    srcs = {path: ":sed-4.0.9[{}]".format(path) for path in FILES} | {
        "config.h": ":config.h",
        "lib/regex.h": ":sed-4.0.9[lib/regex_.h]",
    },
)

TCC = "cellar//bootstrap/stage1/tcc-release"

BOOT = "cellar//bootstrap/stage1/tcc"

tcc_toolchain(
    name = "predecessor",
    cflags = [
        "-nostdinc",
        "-D__SIZEOF_LONG_LONG__=8",
    ],
    execution_runtime = TCC + ":runtime-mes0",
    sysroot = TCC + ":runtime-mes1",
    tcc = TCC + ":tcc-mes1",
)

[
    c_object(
        name = "unit-{}.o".format(i),
        src = ":source[{}]".format(path),
        defines = ["HAVE_CONFIG_H=1"],
        headers = [
            ":source",
            BOOT + ":headers",
        ],
        includes = [
            ":source",
            ":source[lib]",
            BOOT + ":headers",
        ],
        object_name = "s{}.o".format(i),
        toolchain = ":predecessor",
    )
    for i, path in enumerate(LIB_SOURCES + SED_SOURCES)
]

c_library(
    name = "libsed.a",
    objects = [":unit-{}.o".format(i) for i in range(len(LIB_SOURCES))],
    output = "libsed.a",
    toolchain = ":predecessor",
)

c_binary(
    name = "sed",
    libraries = [":libsed.a"],
    objects = [":unit-{}.o".format(i) for i in range(
        len(LIB_SOURCES),
        len(LIB_SOURCES + SED_SOURCES),
    )],
    output = "sed",
    runtime = TCC + ":mes1-link-runtime",
    toolchain = ":predecessor",
)

[
    [
        write_file(
            name = name + "-input",
            content = input,
        ),
        write_file(
            name = name + "-expected",
            content = expected,
        ),
        generate(
            name = name + "-output",
            args = args + ["$(location :" + name + "-input)"],
            capture = True,
            tool = ":sed",
        ),
        compare_test(
            name = name,
            actual = ":" + name + "-output",
            expected = ":" + name + "-expected",
        ),
    ]
    for name, input, args, expected in [
        (
            "backrefs",
            "alpha=12\nbeta=34\n",
            [
                "-e",
                "s/\\([a-z]*\\)=\\([0-9]*\\)/\\2: \\1/",
            ],
            "12: alpha\n34: beta\n",
        ),
        (
            "hold-space",
            "first\nsecond\nthird\n",
            [
                "-n",
                "1h; 2{G;s/\\n/:/;p;}",
            ],
            "second:first\n",
        ),
        (
            "branch",
            "aaaa\nbaaa\n",
            [
                "-e",
                ":again;s/aa/a/;t again",
            ],
            "a\nba\n",
        ),
        (
            "long-line",
            "a" * 8192 + "end\n",
            [
                "-e",
                "s/a//g;s/end/ok/",
            ],
            "ok\n",
        ),
        (
            "no-final-newline",
            "one\ntwo",
            [
                "-e",
                "s/two/three/",
            ],
            "one\nthree",
        ),
    ]
]

command_test(
    name = "malformed-script",
    args = [
        "1",
        "$(exe :sed)",
        "-e",
        "s/missing/",
        "$(location :backrefs-input)",
    ],
    tool = "cellar//bootstrap/stage1/tools:expect-exit",
)

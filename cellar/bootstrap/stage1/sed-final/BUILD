# SPDX-FileCopyrightText: © 2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

load("@cellar//bootstrap:actions.bzl", "command_test", "configured_tool", "generate")
load("@cellar//bootstrap:defs.bzl", "filegroup")
load("@cellar//bootstrap:source.bzl", "exact_patch", "write_file")
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

LIB_SOURCES = ["lib/" + name + ".c" for name in [
    "getopt1",
    "getopt",
    "utils",
    "regex",
    "obstack",
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

CONFIG = {
    "HAVE_POPEN": "1",
    "HAVE_FCHMOD": "1",
    "HAVE_STRINGS_H": "1",
    "HAVE_MEMORY_H": "1",
    "HAVE_MEMPCPY": "1",
    "_GNU_SOURCE": "1",
    "HAVE_STDBOOL_H": "1",
    "HAVE_LOCALE_H": "1",
    "HAVE_WCHAR_H": "1",
    "HAVE_WCTYPE_H": "1",
    "HAVE_MBRTOWC": "1",
    "HAVE_WCRTOMB": "1",
    "HAVE_WCSCOLL": "1",
    "HAVE_ISWCTYPE": "1",
    "HAVE_MBSINIT": "1",
    "HAVE_MBSTATE_T": "1",
    "HAVE_LANGINFO_CODESET": "1",
    "HAVE_SETLOCALE": "1",
    "HAVE_ISBLANK": "1",
    "HAVE_DECL_ISBLANK": "1",
    "HAVE_GETLINE": "1",
    "HAVE_MKSTEMP": "1",
    "HAVE_STRVERSCMP": "1",
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
    srcs = {path: "cellar//bootstrap/stage1/sed:sed-4.0.9[" + path + "]" for path in FILES if path != "sed/sed.c"} | {
        "sed/sed.c": ":locale-source",
        "config.h": ":config.h",
        "lib/regex.h": "cellar//bootstrap/stage1/sed:sed-4.0.9[lib/regex_.h]",
    },
)

[c_object(
    name = "unit-" + str(i) + ".o",
    src = ":source[" + path + "]",
    defines = ["HAVE_CONFIG_H=1"] + (["popen=bootstrap_popen"] if path == "sed/execute.c" else []),
    flags = [
        "-O2",
        "-Werror=implicit-function-declaration",
    ] + ([
        "-include",
        "string.h",
    ] if path in [
        "lib/getopt.c",
        "lib/obstack.c",
        "sed/fmt.c",
    ] else []),
    logical_includes = [
        ".",
        "lib",
    ],
    logical_source = path,
    object_name = "sd" + str(i) + ".o",
    source_alias = "cellar//bootstrap/stage1/tools:source-alias",
    source_tree = ":source",
    toolchain = CC,
) for i, path in enumerate(LIB_SOURCES + SED_SOURCES)]

c_library(
    name = "libsed.a",
    objects = [":unit-" + str(i) + ".o" for i in range(len(LIB_SOURCES))],
    output = "libsed.a",
    toolchain = CC,
)

c_binary(
    name = "sed-bin",
    end_objects = CRTN,
    libraries = [
        ":libsed.a",
        "cellar//bootstrap/stage1/tools-final:libshell.a",
    ] + LIBC,
    objects = CRT + [":unit-" + str(i) + ".o" for i in range(
        len(LIB_SOURCES),
        len(LIB_SOURCES + SED_SOURCES),
    )],
    output = "sed",
    toolchain = CC,
)

filegroup(
    name = "installation",
    srcs = {
        "bin/sed": ":sed-bin",
        "share/licenses/sed/musl-COPYRIGHT": MUSL + ":source[COPYRIGHT]",
        "share/licenses/sed/COPYING": ":source[COPYING]",
    },
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
            capture = "cellar//bootstrap/stage1/tools:capture",
            env = {"LC_ALL": "C.UTF-8"},
            tool = ":sed",
        ),
        command_test(
            name = name,
            args = [
                "$(location :" + name + "-expected)",
                "$(location :" + name + "-output)",
            ],
            tool = "cellar//bootstrap/stage0-posix/cellar-extra:bytecmp",
        ),
    ]
    for name, input, args, expected in [
        (
            "shell-command",
            "printf 'shell-ok\\n'\n",
            ["e"],
            "shell-ok\n",
        ),
        (
            "utf8-match",
            "é界\n",
            ["s/./x/g"],
            "xx\n",
        ),
        (
            "utf8-transliteration",
            "é界\n",
            ["y/é界/É海/"],
            "É海\n",
        ),
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
        "$(exe :sed-bin)",
        "-e",
        "s/missing/",
        "$(location :backrefs-input)",
    ],
    tool = "cellar//bootstrap/stage1/tools:expect-exit",
)

# Locale selection is needed even when message catalogs are disabled.
exact_patch(
    name = "locale-source",
    src = "cellar//bootstrap/stage1/sed:sed-4.0.9[sed/sed.c]",
    after = "#if HAVE_SETLOCALE\n  /* Set locale according to user's wishes.  */\n  setlocale (LC_ALL, \"\");\n#endif\n\n#if ENABLE_NLS\n  /* Tell program which translations to use and where to find.  */",
    before = "#if ENABLE_NLS\n#if HAVE_SETLOCALE\n  /* Set locale according to user's wishes.  */\n  setlocale (LC_ALL, \"\");\n#endif\n\n  /* Tell program which translations to use and where to find.  */",
)

configured_tool(
    name = "sed",
    env = {
        "BOOTSTRAP_SHELL": "$(exe cellar//bootstrap/stage1/bash:bash)",
        "CELLAR_BOOTSTRAP_IDENTITY": "1",
    },
    env_tool = "cellar//bootstrap/stage1/tools:withenv",
    tool = ":sed-bin",
)

filegroup(
    name = "test-source",
    srcs = {"in-place.sh": "tests/in-place.sh"},
)

generate(
    name = "in-place-output",
    args = [
        "--noprofile",
        "--norc",
        "source/in-place.sh",
        "$(exe :sed-bin)",
        "$(exe cellar//bootstrap/stage1/coreutils-final:chmod)",
        "$(exe cellar//bootstrap/stage1/coreutils-final:stat)",
    ],
    chdir = "cellar//bootstrap/stage0-posix/cellar-extra:chdirenv",
    directory = True,
    env = {
        "PATH": "/nonexistent-bootstrap-path",
        "CELLAR_BOOTSTRAP_IDENTITY": "1",
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
    name = "in-place-backup-and-permissions",
    args = [
        "$(location :in-place-output[passed])",
        "$(location :passed)",
    ],
    tool = "cellar//bootstrap/stage0-posix/cellar-extra:bytecmp",
)

command_test(
    name = "missing-shell",
    args = [
        "4",
        "$(exe :sed-bin)",
        "e",
        "$(location :shell-command-input)",
    ],
    env = {"BOOTSTRAP_SHELL": ""},
    tool = "cellar//bootstrap/stage1/tools:expect-exit",
)

# SPDX-FileCopyrightText: 2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

load("@cellar//bootstrap:actions.bzl", "command_test", "configured_tool", "generate")
load("@cellar//bootstrap:defs.bzl", "export_file", "filegroup")
load("@cellar//bootstrap:source.bzl", "download_file", "untar", "write_file")
load("@cellar//bootstrap/stage1:defs.bzl", "c_binary", "c_library", "c_object")
load(":sources.bzl", "HEADERS")

MUSL = "cellar//bootstrap/stage1/musl"

CRT = [
    MUSL + ":restored-crt1.o",
    MUSL + ":restored-crti.o",
]

LIBC = [
    MUSL + ":restored-libc.a",
    "cellar//bootstrap/stage1/tcc-musl:musl2-libtcc1.a",
    MUSL + ":restored-libc.a",
]

LIB = [
    "cloexec",
    "close-stream",
    "dup-safer",
    "error",
    "exitfail",
    "fd-safer",
    "fopen-safer",
    "getopt",
    "getopt1",
    "mkstemp-safer",
    "regex",
    "obstack",
    "tmpfile-safer",
    "verror",
    "xalloc-die",
    "xasprintf",
    "xmalloc",
    "xvasprintf",
]

CORE = [
    "m4",
    "builtin",
    "debug",
    "eval",
    "format",
    "freeze",
    "input",
    "macro",
    "output",
    "path",
    "symtab",
]

FILES = ["lib/" + name + ".c" for name in LIB] + ["src/" + name + ".c" for name in CORE] + HEADERS + [
    "COPYING",
    "lib/regex_internal.c",
    "lib/regcomp.c",
    "lib/regexec.c",
]

# Native Linux/musl configuration; bundled GNU regex and obstack are required.
CONFIG_ON = [
    "HAVE_ALLOCA",
    "HAVE_ALLOCA_H",
    "HAVE_DECL___FPENDING",
    "HAVE___FPENDING",
    "HAVE_DECL_GETENV",
    "HAVE_DECL_ISBLANK",
    "HAVE_GETOPT_H",
    "HAVE_GETOPT_LONG_ONLY",
    "HAVE_GETTIMEOFDAY",
    "HAVE_INTMAX_T",
    "HAVE_INTTYPES_H",
    "HAVE_INTTYPES_H_WITH_UINTMAX",
    "HAVE_ISWCNTRL",
    "HAVE_ISWPRINT",
    "HAVE_LANGINFO_CODESET",
    "HAVE_LIMITS_H",
    "HAVE_LOCALE_H",
    "HAVE_LONG_DOUBLE",
    "HAVE_LONG_LONG",
    "HAVE_LONG_LONG_INT",
    "HAVE_LSTAT",
    "HAVE_MALLOC",
    "HAVE_MBRTOWC",
    "HAVE_MBSTATE_T",
    "HAVE_MEMCHR",
    "HAVE_MEMORY_H",
    "HAVE_MEMPCPY",
    "HAVE_PIPE",
    "HAVE_PTRDIFF_T",
    "HAVE_RLIM_T",
    "HAVE_SETLOCALE",
    "HAVE_STDINT_H",
    "HAVE_STDINT_H_WITH_UINTMAX",
    "HAVE_STDIO_EXT_H",
    "HAVE_STDLIB_H",
    "HAVE_STRERROR_R",
    "HAVE_STRINGS_H",
    "HAVE_STRING_H",
    "HAVE_STRNDUP",
    "HAVE_STRNLEN",
    "HAVE_SYS_RESOURCE_H",
    "HAVE_SYS_STAT_H",
    "HAVE_SYS_TIME_H",
    "HAVE_SYS_WAIT_H",
    "HAVE_UNISTD_H",
    "HAVE_UNSIGNED_LONG_LONG_INT",
    "HAVE_VASPRINTF",
    "HAVE_WCHAR_H",
    "HAVE_WCRTOMB",
    "HAVE_WCSCOLL",
    "HAVE_WCSLEN",
    "HAVE_WCTYPE_H",
    "HAVE_WCWIDTH",
    "HAVE_WINT_T",
    "HAVE__BOOL",
    "HAVE_MKSTEMP",
    "STDC_HEADERS",
]

CONFIG_VALUES = {
    "_GNU_SOURCE": "1",
    "_GL_UNUSED": "",
    "__getopt_argv_const": "const",
    "VERSION": '"1.4.7"',
    "PACKAGE": '"m4"',
    "PACKAGE_NAME": '"GNU M4"',
    "PACKAGE_STRING": '"GNU M4 1.4.7"',
    "PACKAGE_VERSION": '"1.4.7"',
    "PACKAGE_BUGREPORT": '"bug-m4@gnu.org"',
    "RETSIGTYPE": "void",
    "STACK_DIRECTION": "-1",
    "HAVE_DECL_STRERROR_R": "1",
    "HAVE_DECL_WCWIDTH": "1",
    "HAVE_DECL_MKDIR": "1",
    "_REGEX_LARGE_OFFSETS": "1",
}

write_file(
    name = "config.h",
    content = "\n".join(["#define " + name + " 1" for name in CONFIG_ON]) + "\n" +
              "\n".join(["#define " + name + " " + value for name, value in CONFIG_VALUES.items()]) + "\n",
)

download_file(
    name = "m4-1.4.7.tar.bz2",
    hash = "a88f3ddaa7c89cf4c34284385be41ca85e9135369c333fdfa232f3bf48223213",
    urls = ["https://mirrors.kernel.org/gnu/m4/m4-1.4.7.tar.bz2"],
)

generate(
    name = "m4.tar",
    args = [
        "--file",
        "$(location :m4-1.4.7.tar.bz2)",
        "--output",
    ],
    tool = "cellar//bootstrap/stage0-posix/mescc-tools-extra:unbz2",
)

untar(
    name = "m4-1.4.7",
    chdirenv = "cellar//bootstrap/stage0-posix/cellar-extra:chdirenv",
    files = FILES,
    input = ":m4.tar",
    untar = "cellar//bootstrap/stage0-posix/mescc-tools-extra:untar",
)

filegroup(
    name = "source",
    srcs = {path: ":m4-1.4.7[" + path + "]" for path in FILES} | {
        "lib/config.h": ":config.h",
        "lib/getopt.h": ":m4-1.4.7[lib/getopt_.h]",
        "musl-COPYRIGHT": MUSL + ":source-restored[COPYRIGHT]",
    },
)

[
    [
        c_object(
            name = name + ".o",
            src = ":source[" + directory + "/" + name + ".c]",
            defines = ["HAVE_CONFIG_H=1"] + ([
                "system=bootstrap_system",
                "popen=bootstrap_popen",
            ] if name == "builtin" else []) + (["tmpfile=m4_tmpfile"] if name == "tmpfile-safer" else []),
            flags = ["-Werror"],
            headers = [
                ":source",
                MUSL + ":headers",
            ],
            # do not sort
            includes = [
                ":source[lib]",
                ":source[src]",
            ],
            object_name = "m{}.o".format(i),
            toolchain = MUSL + ":tcc",
        )
        for i, name in enumerate(names)
    ]
    for directory, names in [
        ("lib", LIB),
        ("src", CORE),
    ]
]

c_library(
    name = "libm4.a",
    objects = [":" + name + ".o" for name in LIB],
    output = "libm4.a",
    toolchain = MUSL + ":tcc",
)

c_object(
    name = "tmpfile.o",
    src = "tmpfile.c",
    flags = ["-Werror"],
    headers = [MUSL + ":headers"],
    object_name = "tmpfile.o",
    toolchain = MUSL + ":tcc",
)

c_binary(
    name = "m4-bin",
    end_objects = [
        MUSL + ":restored-crtn.o",
    ],
    libraries = [
        ":libm4.a",
        "cellar//bootstrap/stage1/tools:libshell.a",
    ] + LIBC,
    objects = CRT + [":" + name + ".o" for name in CORE] + [
        ":tmpfile.o",
    ],
    output = "m4",
    toolchain = MUSL + ":tcc",
)

configured_tool(
    name = "m4",
    env = {"BOOTSTRAP_SHELL": "$(exe cellar//bootstrap/stage1/bash-bootstrap:bash)"},
    env_tool = "cellar//bootstrap/stage1/tools:withenv",
    tool = ":m4-bin",
)

command_test(
    name = "version",
    args = ["--version"],
    tool = ":m4",
)

filegroup(
    name = "test-source",
    srcs = {path: "tests/" + path for path in [
        "macros.m4",
        "shell.m4",
        "reload.m4",
        "freeze.m4",
        "included.m4",
    ]},
)

configured_tool(
    name = "capture-m4",
    args = [
        "result",
        "$(exe :m4-bin)",
    ],
    env = {"BOOTSTRAP_SHELL": "$(exe cellar//bootstrap/stage1/bash-bootstrap:bash)"},
    env_tool = "cellar//bootstrap/stage1/tools:withenv",
    tool = "cellar//bootstrap/stage1/tools:capture",
)

[
    [
        generate(
            name = name + "-output",
            args = [
                "-I",
                "$(location :test-source)",
            ] + args + [input],
            chdir = "cellar//bootstrap/stage0-posix/cellar-extra:chdirenv",
            directory = True,
            env = {
                "TMPDIR": ".",
                "PATH": "/nonexistent-bootstrap-tools",
                "LC_ALL": "C.UTF-8",
            },
            files = ["result"],
            tool = ":capture-m4",
        ),
        command_test(
            name = name,
            args = [
                "$(location :" + name + "-output[result])",
                "$(location :diversion-expected)" if name == "diversion" else "$(location :tests/" + name + ".expected)",
            ],
            tool = "cellar//bootstrap/stage0-posix/cellar-extra:bytecmp",
        ),
    ]
    for name, input, args in [
        ("macros", "$(location :test-source[macros.m4])", []),
        ("shell", "$(location :test-source[shell.m4])", []),
        (
            "reload",
            "$(location :test-source[reload.m4])",
            [
                "-R",
                "$(location :frozen-state)",
            ],
        ),
        ("diversion", "$(location :large-diversion)", []),
    ]
]

[
    export_file(
        name = "tests/" + name + ".expected",
    )
    for name in [
        "macros",
        "shell",
        "reload",
    ]
]

generate(
    name = "frozen-state",
    args = [
        "$(location :test-source[freeze.m4])",
        "-F",
    ],
    tool = ":m4",
)

# More than m4's 512 KiB in-memory diversion limit, forcing the tmpfile path.
DIVERSION_TEXT = ("Z" * 1024 + "\n") * 600

write_file(
    name = "large-diversion",
    content = "divert(1)dnl\n" + DIVERSION_TEXT + "divert(0)undivert(1)dnl\n",
)

write_file(
    name = "diversion-expected",
    content = DIVERSION_TEXT,
)

export_file(
    name = "tests/malformed.m4",
)

export_file(
    name = "tests/missing-shell.m4",
)

command_test(
    name = "diagnostic",
    args = [
        "1",
        "$(exe :m4-bin)",
        "$(location :tests/malformed.m4)",
    ],
    tool = "cellar//bootstrap/stage1/tools:expect-exit",
)

command_test(
    name = "missing-shell",
    args = ["$(location :tests/missing-shell.m4)"],
    env = {"BOOTSTRAP_SHELL": ""},
    tool = ":m4-bin",
)

command_test(
    name = "missing-temporary-directory",
    args = [
        "1",
        "$(exe :m4-bin)",
        "$(location :large-diversion)",
    ],
    env = {"TMPDIR": ""},
    tool = "cellar//bootstrap/stage1/tools:expect-exit",
)

export_file(name = "tmpfile.c")

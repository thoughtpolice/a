# SPDX-FileCopyrightText: 2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

load("@cellar//bootstrap:actions.bzl", "command_test", "configured_tool", "generate")
load("@cellar//bootstrap:defs.bzl", "export_file", "filegroup")
load("@cellar//bootstrap:source.bzl", "write_file")
load("@cellar//bootstrap/stage1:defs.bzl", "c_binary", "c_library", "c_object")
load("@cellar//bootstrap/stage1/bison:sources.bzl", "DATA", "HEADERS")

GCC = "cellar//bootstrap/stage1/gcc47"

MUSL = "cellar//bootstrap/stage1/musl12"

CC = GCC + ":stage3-gcc"

SOURCE_ALIAS = "cellar//bootstrap/stage1/tools:source-alias"

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

CORE = [
    "AnnotationList",
    "assoc",
    "closure",
    "complain",
    "conflicts",
    "derives",
    "files",
    "fixits",
    "getargs",
    "gram",
    "graphviz",
    "ielr",
    "InadequacyList",
    "lalr",
    "location",
    "lr0",
    "main",
    "muscle-tab",
    "named-ref",
    "nullable",
    "output",
    "print",
    "print-graph",
    "print-xml",
    "reader",
    "reduce",
    "relation",
    "Sbitset",
    "state",
    "symlist",
    "symtab",
    "tables",
    "uniqstr",
]

# Native musl supplies the POSIX, allocation, string, math and spawn functions;
# retain gnulib's application helpers, bitsets and formatting implementation.
LIB = [
    "allocator",
    "areadlink",
    "argmatch",
    "asnprintf",
    "basename",
    "basename-lgpl",
    "binary-io",
    "bitrotate",
    "bitset",
    "bitsetv",
    "careadlinkat",
    "c-ctype",
    "cloexec",
    "closeout",
    "close-stream",
    "concat-filename",
    "c-strcasecmp",
    "c-strncasecmp",
    "dirname",
    "dirname-lgpl",
    "dup-safer",
    "dup-safer-flag",
    "exitfail",
    "fatal-signal",
    "fd-safer",
    "fd-safer-flag",
    "fopen-safer",
    "get-errno",
    "gethrxtime",
    "getprogname",
    "gettime",
    "gl_array_list",
    "gl_list",
    "gl_xlist",
    "hard-locale",
    "hash",
    "localcharset",
    "localtime-buffer",
    "malloca",
    "mbswidth",
    "obstack",
    "obstack_printf",
    "path-join",
    "pipe2-safer",
    "pipe-safer",
    "printf-args",
    "printf-parse",
    "progname",
    "progreloc",
    "quotearg",
    "relocatable",
    "stat-time",
    "stripslash",
    "timespec",
    "timevar",
    "vasnprintf",
    "wait-process",
    "xalloc-die",
    "xconcat-filename",
    "xmalloc",
    "xmemdup0",
    "xreadlink",
    "xsize",
    "xstrndup",
    "xtime",
    "error",
    "bitset/array",
    "bitset/list",
    "bitset/stats",
    "bitset/table",
    "bitset/vector",
    "spawn-pipe",
]

SCANNERS = [
    "scan-code",
    "scan-gram",
    "scan-skel",
]

FILES = ["src/" + name + ".c" for name in CORE] + ["lib/" + name + ".c" for name in LIB] + ["src/" + name + suffix for name in SCANNERS for suffix in [
    ".l",
    "-c.c",
]] + HEADERS + ["data/" + name for name in DATA] + [
    "src/parse-gram.y",
    "lib/timevar.def",
    "lib/textstyle.in.h",
    "COPYING",
]

# Reviewed Linux/x86_64 musl configuration; no installed locale catalogs.
CONFIG_ON = [
    "GNULIB_FOPEN_SAFER",
    "GNULIB_FD_SAFER_FLAG",
    "GNULIB_PIPE2_SAFER",
    "HAVE___FSETERR",
    "HAVE_DECL_PROGRAM_INVOCATION_SHORT_NAME",
    "HAVE_DECL_STRERROR_R",
    "HAVE_GETTIMEOFDAY",
    "HAVE_PIPE",
    "HAVE_SNPRINTF",
    "HAVE_STDINT_H",
    "HAVE_UNISTD_H",
    "HAVE_ALLOCA_H",
    "HAVE_LONG_LONG_INT",
    "HAVE_WCHAR_T",
    "HAVE_WINT_T",
    "HAVE_LANGINFO_CODESET",
    "HAVE_CLOCK_GETTIME",
    "HAVE_DECL_TZNAME",
    "HAVE_SYS_RESOURCE_H",
    "HAVE_GETRUSAGE",
    "FUNC_REALPATH_WORKS",
    "HAVE_GETCWD",
    "HAVE_LSTAT",
    "HAVE_READLINK",
    "HAVE_ISWCNTRL",
    "HAVE_WCWIDTH",
    "HAVE_DECL_WCWIDTH",
    "HAVE_TCDRAIN",
    "HAVE_MALLOC_POSIX",
    "HAVE_MALLOC_GNU",
    "HAVE_STRUCT_TM_TM_ZONE",
    "HAVE_TM_GMTOFF",
]

CONFIG_VALUES = {
    "_GNU_SOURCE": "1",
    "restrict": "__restrict",
    "O_BINARY": "0",
    "O_TEXT": "0",
    "M4": "\"/nonexistent-bootstrap-m4\"",
    "M4_GNU_OPTION": "\"\"",
    "PACKAGE": "\"bison\"",
    "PACKAGE_BUGREPORT": "\"bug-bison@gnu.org\"",
    "PACKAGE_COPYRIGHT_YEAR": "2019",
    "PACKAGE_NAME": "\"GNU Bison\"",
    "PACKAGE_STRING": "\"GNU Bison 3.4.1\"",
    "PACKAGE_URL": "\"https://www.gnu.org/software/bison/\"",
    "PACKAGE_VERSION": "\"3.4.1\"",
    "VERSION": "\"3.4.1\"",
    "PROMOTED_MODE_T": "mode_t",
    "BOURNE_SHELL": "\"/nonexistent-bootstrap-shell\"",
    "SIZEOF_LONG": "8",
    "SIZEOF_LONG_LONG": "8",
    "SIZEOF_VOID_P": "8",
    "_GL_ASYNC_SAFE": "",
    "_GL_EXTERN_INLINE": "extern inline",
    "_GL_INLINE": "static inline",
    "_GL_INLINE_HEADER_BEGIN": "",
    "_GL_INLINE_HEADER_END": "",
    "_GL_UNUSED": "",
    "_GL_UNUSED_LABEL": "",
    "_GL_ATTRIBUTE_PURE": "",
    "_GL_ATTRIBUTE_CONST": "",
    "_GL_ATTRIBUTE_MALLOC": "",
    "_GL_ATTRIBUTE_FORMAT_PRINTF(x, y)": "",
    "_GL_ARG_NONNULL(x)": "",
}

write_file(
    name = "config.h",
    content = "\n".join(["#define " + name + " 1" for name in CONFIG_ON]) + "\n" + "\n".join(["#define " + name + " " + value for name, value in CONFIG_VALUES.items()]) + "\n",
)

write_file(
    name = "configmake.h",
    content = '#define LOCALEDIR "/nonexistent-bootstrap-locales"\n#define PKGDATADIR "/nonexistent-bootstrap-bison"\n',
)

filegroup(
    name = "source",
    srcs = {path: "cellar//bootstrap/stage1/bison:source[" + path + "]" for path in FILES} | {
        "config.h": ":config.h",
        "native-declarations.h": "cellar//bootstrap/stage1/bison:source[native-declarations.h]",
        "lib/configmake.h": ":configmake.h",
        "lib/textstyle.h": "cellar//bootstrap/stage1/bison:source[lib/textstyle.in.h]",
    },
)

filegroup(
    name = "data",
    srcs = {path: ":source[data/" + path + "]" for path in DATA},
)

[
    generate(
        name = name,
        args = [
            "-L",
            "-t",
            "src/" + name + ".l",
        ],
        capture = "cellar//bootstrap/stage1/tools:capture",
        output = name + ".c",
        tool = "cellar//bootstrap/stage1/flex-final:flex",
        working_directory = ":source",
    )
    for name in SCANNERS
]

[
    c_object(
        name = "lib-{}.o".format(i),
        src = ":source[lib/" + name + ".c]",
        flags = [
            "-O2",
            "-std=gnu99",
            "-Werror",
            "-include",
            "native-declarations.h",
        ],
        headers = [
            ":source",
            MUSL + ":headers",
        ],
        logical_includes = [
            ".",
            "lib",
            "src",
        ],
        logical_source = "lib/" + name + ".c",
        object_name = "l{}.o".format(i),
        source_alias = SOURCE_ALIAS,
        source_tree = ":source",
        toolchain = CC,
    )
    for i, name in enumerate(LIB)
]

c_library(
    name = "libbison.a",
    objects = [":lib-{}.o".format(i) for i in range(len(LIB))],
    output = "libbison.a",
    toolchain = CC,
)

# The handwritten -> simplified -> full parser passes remain in the predecessor.
PARSER_STAGES = [("full", "cellar//bootstrap/stage1/bison:bison", ":source[src/parse-gram.y]")]

[
    [
        generate(
            name = stage + "-parser",
            args = [
                "--no-lines",
                "--defines=parse-gram.h",
                "-o",
                "parse-gram.c",
                "source/src/parse-gram.y",
            ],
            chdir = "cellar//bootstrap/stage0-posix/cellar-extra:chdirenv",
            directory = True,
            env = {
                "TMPDIR": ".",
                "LC_ALL": "C.UTF-8",
            },
            files = [
                "parse-gram.c",
                "parse-gram.h",
            ],
            source_alias = SOURCE_ALIAS,
            source_tree = ":source",
            tool = predecessor,
        ),
        filegroup(
            name = stage + "-source",
            srcs = {path: ":source[" + path + "]" for path in FILES + [
                       "native-declarations.h",
                       "config.h",
                       "lib/configmake.h",
                       "lib/textstyle.h",
                   ]} |
                   {
                       "src/parse-gram.c": ":" + stage + "-parser[parse-gram.c]",
                       "src/parse-gram.h": ":" + stage + "-parser[parse-gram.h]",
                   } |
                   {"src/" + name + ".c": ":" + name for name in SCANNERS},
        ),
        [
            c_object(
                name = stage + "-{}.o".format(i),
                src = ":" + stage + "-source[src/" + name + ".c]",
                flags = [
                    "-O2",
                    "-std=gnu99",
                    "-Werror",
                    "-include",
                    "native-declarations.h",
                ],
                headers = [
                    ":" + stage + "-source",
                    MUSL + ":headers",
                ],
                logical_includes = [
                    ".",
                    "lib",
                    "src",
                ],
                logical_source = "src/" + name + ".c",
                object_name = "c{}.o".format(i),
                source_alias = SOURCE_ALIAS,
                source_tree = ":" + stage + "-source",
                toolchain = CC,
            )
            for i, name in enumerate(CORE + ["parse-gram"] + [name + "-c" for name in SCANNERS])
        ],
        c_binary(
            name = "bison-" + stage + "-bin",
            libraries = [":libbison.a"] + LIBC,
            objects = CRT + [":" + stage + "-{}.o".format(i) for i in range(len(CORE) + 4)] + CRTN,
            output = "bison",
            toolchain = CC,
        ),
        configured_tool(
            name = "bison-" + stage,
            env = {
                "M4": "$(exe cellar//bootstrap/stage1/m4-final:m4-bin)",
                "BOOTSTRAP_SHELL": "$(exe cellar//bootstrap/stage1/bash:bash)",
                "CELLAR_BOOTSTRAP_IDENTITY": "1",
                "BISON_PKGDATADIR": "$(location :data)",
            },
            env_tool = "cellar//bootstrap/stage1/tools:withenv",
            tool = ":bison-" + stage + "-bin",
        ),
        generate(
            name = stage + "-calculator",
            args = [
                "--no-lines",
                "--defines=calculator.h",
                "-o",
                "calculator.c",
                "$(location cellar//bootstrap/stage1/bison:calculator.y)",
            ],
            chdir = "cellar//bootstrap/stage0-posix/cellar-extra:chdirenv",
            directory = True,
            env = {
                "TMPDIR": ".",
                "LC_ALL": "C.UTF-8",
            },
            files = [
                "calculator.c",
                "calculator.h",
            ],
            tool = ":bison-" + stage,
        ),
        c_object(
            name = stage + "-calculator.o",
            src = ":" + stage + "-calculator[calculator.c]",
            flags = [
                "-O2",
                "-std=gnu99",
                "-Werror",
            ],
            headers = [
                ":" + stage + "-calculator",
                MUSL + ":headers",
            ],
            includes = [":" + stage + "-calculator"],
            object_name = "calc.o",
            toolchain = CC,
        ),
        c_binary(
            name = stage + "-calculator-bin",
            libraries = LIBC,
            objects = CRT + [
                ":" + stage + "-calculator.o",
            ] + CRTN,
            toolchain = CC,
        ),
        command_test(
            name = stage + "-version",
            args = ["--version"],
            tool = ":bison-" + stage,
        ),
        [
            command_test(
                name = stage + "-" + name,
                args = [
                    input,
                    output,
                ],
                tool = ":" + stage + "-calculator-bin",
            )
            for name, input, output in [
                ("precedence", "4+7*3", "25"),
                ("parentheses", "(4+7)*3", "33"),
                ("native-values", "4294967296+17", "4294967313"),
            ]
        ],
        command_test(
            name = stage + "-syntax-error",
            args = [
                "2",
                "$(exe :" + stage + "-calculator-bin)",
                "3+)",
                "0",
            ],
            tool = "cellar//bootstrap/stage1/tools:expect-exit",
        ),
    ]
    for stage, predecessor, grammar in PARSER_STAGES
]

configured_tool(
    name = "bison",
    tool = ":bison-full",
)

generate(
    name = "full-parser-again",
    args = [
        "--no-lines",
        "--defines=parse-gram.h",
        "-o",
        "parse-gram.c",
        "source/src/parse-gram.y",
    ],
    chdir = "cellar//bootstrap/stage0-posix/cellar-extra:chdirenv",
    directory = True,
    env = {
        "TMPDIR": ".",
        "LC_ALL": "C.UTF-8",
    },
    files = [
        "parse-gram.c",
        "parse-gram.h",
    ],
    source_alias = SOURCE_ALIAS,
    source_tree = ":source",
    tool = ":bison",
)

[
    command_test(
        name = "regenerated-" + extension,
        args = [
            "$(location :full-parser[parse-gram." + extension + "])",
            "$(location :full-parser-again[parse-gram." + extension + "])",
        ],
        tool = "cellar//bootstrap/stage0-posix/cellar-extra:bytecmp",
    )
    for extension in [
        "c",
        "h",
    ]
]

[
    [
        generate(
            name = name + "-parser",
            args = [
                "--no-lines",
                "-o",
                "parser.c",
                "$(location cellar//bootstrap/stage1/bison:" + name + ".y)",
            ],
            chdir = "cellar//bootstrap/stage0-posix/cellar-extra:chdirenv",
            directory = True,
            env = {"TMPDIR": "."},
            files = ["parser.c"],
            tool = ":bison",
        ),
        c_object(
            name = name + "-test.o",
            src = ":" + name + "-parser[parser.c]",
            flags = [
                "-O2",
                "-std=gnu99",
                "-Werror",
            ],
            headers = [MUSL + ":headers"],
            object_name = "test.o",
            toolchain = CC,
        ),
        c_binary(
            name = name + "-test-bin",
            libraries = LIBC,
            objects = CRT + [
                ":" + name + "-test.o",
            ] + CRTN,
            toolchain = CC,
        ),
    ]
    for name in [
        "glr",
        "cleanup",
    ]
]

[
    command_test(
        name = "glr-" + input,
        args = [
            input,
            answer,
        ],
        tool = ":glr-test-bin",
    )
    for input, answer in [
        ("acd", "1"),
        ("bce", "2"),
        ("ace", "3"),
        ("bcd", "4"),
    ]
]

command_test(
    name = "glr-syntax-error",
    args = [
        "2",
        "$(exe :glr-test-bin)",
        "abc",
        "0",
    ],
    tool = "cellar//bootstrap/stage1/tools:expect-exit",
)

[command_test(
    name = "cleanup-" + input,
    args = [input],
    tool = ":cleanup-test-bin",
) for input in [
    "valid",
    "invalid",
]]

export_file(name = "cpp.y")

generate(
    name = "cpp-parser",
    args = [
        "--no-lines",
        "--defines=parser.hh",
        "-o",
        "parser.cc",
        "$(location :cpp.y)",
    ],
    chdir = "cellar//bootstrap/stage0-posix/cellar-extra:chdirenv",
    directory = True,
    env = {"TMPDIR": "."},
    files = [
        "parser.cc",
        "parser.hh",
        "stack.hh",
    ],
    tool = ":bison",
)

generate(
    name = "cpp-program",
    args = [
        "-O2",
        "-g0",
        "-frandom-seed=bootstrap",
        "-std=gnu++11",
        "-Werror",
        "-Isource",
        "source/parser.cc",
        "-o",
        "program",
    ],
    chdir = "cellar//bootstrap/stage0-posix/cellar-extra:chdirenv",
    directory = True,
    files = ["program"],
    source_alias = SOURCE_ALIAS,
    source_tree = ":cpp-parser",
    tool = "cellar//bootstrap/stage1/libstdcxx:stage3-g++",
)

[command_test(
    name = "cpp-" + name,
    args = [
        status,
        "$(location :cpp-program[program])",
        input,
        answer,
    ],
    tool = "cellar//bootstrap/stage1/tools:expect-exit",
) for name, status, input, answer in [
    ("values", "0", "4294967296+7*3", "4294967317"),
    ("precedence", "0", "(4+7)*3", "33"),
    ("syntax-error", "2", "(4+)", "0"),
]]

command_test(
    name = "missing-m4",
    args = [
        "1",
        "$(exe :bison-full-bin)",
        "-o",
        "/dev/null",
        "$(location cellar//bootstrap/stage1/bison:calculator.y)",
    ],
    env = {
        "M4": "",
        "BISON_PKGDATADIR": "$(location :data)",
    },
    tool = "cellar//bootstrap/stage1/tools:expect-exit",
)

filegroup(
    name = "installation",
    srcs = {"share/bison/" + path: ":data[" + path + "]" for path in DATA} | {
        "bin/bison": ":bison-full-bin",
        "share/licenses/bison/COPYING": ":source[COPYING]",
    },
)

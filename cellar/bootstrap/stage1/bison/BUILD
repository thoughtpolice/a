# SPDX-FileCopyrightText: 2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

load("@cellar//bootstrap:actions.bzl", "command_test", "configured_tool", "generate")
load("@cellar//bootstrap:defs.bzl", "export_file", "filegroup")
load("@cellar//bootstrap:source.bzl", "download_file", "exact_patch", "untar", "write_file")
load("@cellar//bootstrap/stage1:defs.bzl", "c_binary", "c_library", "c_object")
load(":sources.bzl", "DATA", "HEADERS")

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
    "HAVE_CANONICALIZE_FILE_NAME",
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
    "_Noreturn": "",
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

[export_file(name = path) for path in glob([
    "seed/*",
    "patches/*.patch",
])]

download_file(
    name = "bison-3.4.1.tar.xz",
    hash = "27159ac5ebf736dffd5636fd2cd625767c9e437de65baa63cb0de83570bd820d",
    urls = ["https://mirrors.kernel.org/gnu/bison/bison-3.4.1.tar.xz"],
)

generate(
    name = "bison.tar",
    args = [
        "--file",
        "$(location :bison-3.4.1.tar.xz)",
        "--output",
    ],
    tool = "cellar//bootstrap/stage0-posix/mescc-tools-extra:unxz",
)

untar(
    name = "bison-3.4.1",
    chdirenv = "cellar//bootstrap/stage0-posix/cellar-extra:chdirenv",
    files = FILES,
    input = ":bison.tar",
    untar = "cellar//bootstrap/stage0-posix/mescc-tools-extra:untar",
)

[
    exact_patch(
        name = name + "-source",
        src = ":bison-3.4.1[" + path + "]",
        patch = ":patches/" + name + ".patch",
    )
    for name, path in [
        ("m4", "src/output.c"),
    ]
]

filegroup(
    name = "source",
    srcs = {path: ":bison-3.4.1[" + path + "]" for path in FILES} | {
        "config.h": ":config.h",
        "native-declarations.h": "native-declarations.h",
        "lib/configmake.h": ":configmake.h",
        "lib/textstyle.h": ":bison-3.4.1[lib/textstyle.in.h]",
        "src/output.c": ":m4-source",
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
            "$(location :source[src/" + name + ".l])",
        ],
        capture = "cellar//bootstrap/stage1/tools:capture",
        tool = "cellar//bootstrap/stage1/flex:flex",
    )
    for name in SCANNERS
]

[
    c_object(
        name = "lib-{}.o".format(i),
        src = ":source[lib/" + name + ".c]",
        flags = [
            "-Werror",
            "-include",
            "native-declarations.h",
        ],
        headers = [
            ":source",
            MUSL + ":headers",
        ],
        includes = [
            ":source",
            ":source[lib]",
            ":source[src]",
        ],
        object_name = "l{}.o".format(i),
        toolchain = MUSL + ":tcc",
    )
    for i, name in enumerate(LIB)
]

c_library(
    name = "libbison.a",
    objects = [":lib-{}.o".format(i) for i in range(len(LIB))],
    output = "libbison.a",
    toolchain = MUSL + ":tcc",
)

filegroup(
    name = "seed-source",
    srcs = {path: ":source[" + path + "]" for path in FILES + [
        "native-declarations.h",
        "config.h",
        "lib/configmake.h",
        "lib/textstyle.h",
    ]} | {
        "src/parse-gram.c": ":seed/parse-gram.c",
        "src/parse-gram.h": ":seed/parse-gram.h",
    } | {"src/" + name + ".c": ":" + name for name in SCANNERS},
)

[
    c_object(
        name = "seed-{}.o".format(i),
        src = ":seed-source[src/" + name + ".c]",
        flags = [
            "-Werror",
            "-include",
            "native-declarations.h",
        ],
        headers = [
            ":seed-source",
            MUSL + ":headers",
        ],
        includes = [
            ":seed-source",
            ":seed-source[lib]",
            ":seed-source[src]",
        ],
        object_name = "c{}.o".format(i),
        toolchain = MUSL + ":tcc",
    )
    for i, name in enumerate(CORE + ["parse-gram"] + [name + "-c" for name in SCANNERS])
]

c_binary(
    name = "bison-seed-bin",
    end_objects = [MUSL + ":restored-crtn.o"],
    libraries = [":libbison.a"] + LIBC,
    objects = CRT + [":seed-{}.o".format(i) for i in range(len(CORE) + 4)],
    output = "bison",
    toolchain = MUSL + ":tcc",
)

configured_tool(
    name = "bison-seed",
    env = {
        "M4": "$(exe cellar//bootstrap/stage1/m4:m4-bin)",
        "BOOTSTRAP_SHELL": "$(exe cellar//bootstrap/stage1/bash-bootstrap:bash)",
        "BISON_PKGDATADIR": "$(location :data)",
    },
    env_tool = "cellar//bootstrap/stage1/tools:withenv",
    tool = ":bison-seed-bin",
)

command_test(
    name = "seed-version",
    args = ["--version"],
    tool = ":bison-seed",
)

export_file(name = "calculator.y")

generate(
    name = "seed-calculator",
    args = [
        "--no-lines",
        "--defines=calculator.h",
        "-o",
        "calculator.c",
        "$(location :calculator.y)",
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
    tool = ":bison-seed",
)

c_object(
    name = "seed-calculator.o",
    src = ":seed-calculator[calculator.c]",
    flags = ["-Werror"],
    headers = [
        ":seed-calculator",
        MUSL + ":headers",
    ],
    includes = [":seed-calculator"],
    object_name = "calc.o",
    toolchain = MUSL + ":tcc",
)

c_binary(
    name = "seed-calculator-bin",
    end_objects = [
        MUSL + ":restored-crtn.o",
    ],
    libraries = LIBC,
    objects = CRT + [
        ":seed-calculator.o",
    ],
    toolchain = MUSL + ":tcc",
)

[
    command_test(
        name = "seed-" + name,
        args = [
            input,
            output,
        ],
        tool = ":seed-calculator-bin",
    )
    for name, input, output in [
        ("precedence", "4+7*3", "25"),
        ("parentheses", "(4+7)*3", "33"),
        ("native-values", "4294967296+17", "4294967313"),
    ]
]

command_test(
    name = "seed-syntax-error",
    args = [
        "2",
        "$(exe :seed-calculator-bin)",
        "3+)",
        "0",
    ],
    tool = "cellar//bootstrap/stage1/tools:expect-exit",
)

# Preserve the corrective parser sequence from the pinned bootstrap recipe.
PARSER_STAGES = [
    ("simple", ":bison-seed", ":seed/parse-gram.y"),
    ("full", ":bison-simple", ":source[src/parse-gram.y]"),
]

[
    [
        generate(
            name = stage + "-parser",
            args = [
                "--no-lines",
                "--defines=parse-gram.h",
                "-o",
                "parse-gram.c",
                "$(location " + grammar + ")",
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
                    "-Werror",
                    "-include",
                    "native-declarations.h",
                ],
                headers = [
                    ":" + stage + "-source",
                    MUSL + ":headers",
                ],
                includes = [
                    ":" + stage + "-source",
                    ":" + stage + "-source[lib]",
                    ":" + stage + "-source[src]",
                ],
                object_name = "c{}.o".format(i),
                toolchain = MUSL + ":tcc",
            )
            for i, name in enumerate(CORE + ["parse-gram"] + [name + "-c" for name in SCANNERS])
        ],
        c_binary(
            name = "bison-" + stage + "-bin",
            end_objects = [MUSL + ":restored-crtn.o"],
            libraries = [":libbison.a"] + LIBC,
            objects = CRT + [":" + stage + "-{}.o".format(i) for i in range(len(CORE) + 4)],
            output = "bison",
            toolchain = MUSL + ":tcc",
        ),
        configured_tool(
            name = "bison-" + stage,
            env = {
                "M4": "$(exe cellar//bootstrap/stage1/m4:m4-bin)",
                "BOOTSTRAP_SHELL": "$(exe cellar//bootstrap/stage1/bash-bootstrap:bash)",
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
                "$(location :calculator.y)",
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
            flags = ["-Werror"],
            headers = [
                ":" + stage + "-calculator",
                MUSL + ":headers",
            ],
            includes = [":" + stage + "-calculator"],
            object_name = "calc.o",
            toolchain = MUSL + ":tcc",
        ),
        c_binary(
            name = stage + "-calculator-bin",
            end_objects = [
                MUSL + ":restored-crtn.o",
            ],
            libraries = LIBC,
            objects = CRT + [
                ":" + stage + "-calculator.o",
            ],
            toolchain = MUSL + ":tcc",
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
        "$(location :source[src/parse-gram.y])",
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

[export_file(name = name + ".y") for name in [
    "glr",
    "cleanup",
]]

[
    [
        generate(
            name = name + "-parser",
            args = [
                "--no-lines",
                "-o",
                "parser.c",
                "$(location :" + name + ".y)",
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
            flags = ["-Werror"],
            headers = [MUSL + ":headers"],
            object_name = "test.o",
            toolchain = MUSL + ":tcc",
        ),
        c_binary(
            name = name + "-test-bin",
            end_objects = [
                MUSL + ":restored-crtn.o",
            ],
            libraries = LIBC,
            objects = CRT + [
                ":" + name + "-test.o",
            ],
            toolchain = MUSL + ":tcc",
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

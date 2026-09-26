# SPDX-FileCopyrightText: © 2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

load("@cellar//bootstrap:actions.bzl", "command_test", "compare_test", "configured_tool", "generate")
load("@cellar//bootstrap:defs.bzl", "export_file", "filegroup")
load("@cellar//bootstrap:source.bzl", "download_file", "exact_patch", "untar", "write_file")
load("@cellar//bootstrap/stage1:defs.bzl", "c_binary", "c_library", "c_object")
load(":defs.bzl", "bison_pass")
load(":sources.bzl", "CORE", "DATA", "HEADERS", "SCANNERS")

MUSL = "cellar//bootstrap/stage1/musl"

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
        capture = True,
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

# Everything a pass compiles, except its parser and scanners.
PASS_FILES = FILES + [
    "native-declarations.h",
    "config.h",
    "lib/configmake.h",
    "lib/textstyle.h",
]

# The seed pass compiles the handwritten parser.
bison_pass(
    name = "seed",
    files = PASS_FILES,
    parser = {
        "src/parse-gram.c": ":seed/parse-gram.c",
        "src/parse-gram.h": ":seed/parse-gram.h",
    },
)

export_file(name = "calculator.y")

# Each later pass compiles the parser that its predecessor generated from the
# pinned recipe's simplified grammar, then from the upstream grammar.
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
            chdir = True,
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
        bison_pass(
            name = stage,
            files = PASS_FILES,
            parser = {
                "src/parse-gram.c": ":" + stage + "-parser[parse-gram.c]",
                "src/parse-gram.h": ":" + stage + "-parser[parse-gram.h]",
            },
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
    chdir = True,
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
    compare_test(
        name = "regenerated-" + extension,
        actual = ":full-parser-again[parse-gram." + extension + "]",
        expected = ":full-parser[parse-gram." + extension + "]",
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
            chdir = True,
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
            objects = [":" + name + "-test.o"],
            runtime = MUSL + ":tcc-link-runtime",
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

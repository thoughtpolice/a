# SPDX-FileCopyrightText: © 2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

load("@cellar//bootstrap:actions.bzl", "command_test", "generate")
load("@cellar//bootstrap:defs.bzl", "export_file", "filegroup")
load("@cellar//bootstrap:source.bzl", "download_file", "exact_patch", "ungz", "untar", "write_file")
load("@cellar//bootstrap/stage1:defs.bzl", "c_binary", "c_object")

SOURCES = [
    "closure.c",
    "error.c",
    "lalr.c",
    "lr0.c",
    "main.c",
    "mkpar.c",
    "output.c",
    "reader.c",
    "skeleton.c",
    "symtab.c",
    "verbose.c",
    "warshall.c",
    "portable.c",
]

FILES = SOURCES + [
    "defs.h",
    "portable.h",
    "README.md",
    "yacc.1",
]

MUSL = "cellar//bootstrap/stage1/musl"

SUPPORT = "cellar//bootstrap/stage1/tcc-musl:musl2-libtcc1.a"

download_file(
    name = "oyacc-6.6.tar.gz",
    hash = "eb0866e740b79bd3a23e0ca47885eb3148aab18d77a4bedba96e979d8b4ebfe1",
    urls = ["https://github.com/ibara/yacc/releases/download/oyacc-6.6/oyacc-6.6.tar.gz"],
)

ungz(
    name = "oyacc.tar",
    input = ":oyacc-6.6.tar.gz",
    ungz = "cellar//bootstrap/stage0-posix/mescc-tools-extra:ungz",
)

untar(
    name = "oyacc-6.6",
    chdirenv = "cellar//bootstrap/stage0-posix/cellar-extra:chdirenv",
    files = FILES,
    input = ":oyacc.tar",
    untar = "cellar//bootstrap/stage0-posix/mescc-tools-extra:untar",
)

# Reviewed Linux/musl configuration. Use upstream reallocarray portability
# code because musl 1.1.24 does not provide that function.
write_file(
    name = "config.h",
    content = "\n".join(["#define " + value for value in [
        "__dead __attribute__((noreturn))",
        "__unused",
        "HAVE_PROGNAME 1",
        "HAVE_ASPRINTF 1",
        "HAVE_STRLCPY 1",
    ]]) + "\n",
)

# Keep temporary generator files inside the declared output directory.
exact_patch(
    name = "main-source",
    src = ":oyacc-6.6[main.c]",
    after = "\ttmpdir = getenv(\"TMPDIR\");\n\tif (!tmpdir || !*tmpdir) tmpdir = _PATH_TMP;\n",
    before = "\ttmpdir = _PATH_TMP;\n",
)

filegroup(
    name = "source",
    srcs = {path: ":oyacc-6.6[" + path + "]" for path in FILES} | {
        "config.h": ":config.h",
        "main.c": ":main-source",
    },
)

[
    c_object(
        name = path + ".o",
        src = ":source[" + path + "]",
        defines = ["_GNU_SOURCE=1"],
        flags = ["-Werror"],
        headers = [
            ":source",
            MUSL + ":headers",
        ],
        includes = [":source"],
        object_name = "y{}.o".format(i),
        toolchain = MUSL + ":tcc",
    )
    for i, path in enumerate(SOURCES)
]

c_binary(
    name = "oyacc",
    end_objects = [MUSL + ":restored-crtn.o"],
    libraries = [
        MUSL + ":restored-libc.a",
        SUPPORT,
        MUSL + ":restored-libc.a",
    ],
    objects = [
        MUSL + ":restored-crt1.o",
        MUSL + ":restored-crti.o",
    ] + [":" + path + ".o" for path in SOURCES],
    output = "oyacc",
    toolchain = MUSL + ":tcc",
)

export_file(name = "calculator.y")

generate(
    name = "calculator-source",
    args = [
        "-d",
        "-l",
        "-o",
        "calc.c",
        "$(location :calculator.y)",
    ],
    chdir = "cellar//bootstrap/stage0-posix/cellar-extra:chdirenv",
    directory = True,
    env = {"TMPDIR": "."},
    files = [
        "calc.c",
        "calc.h",
    ],
    tool = ":oyacc",
)

c_object(
    name = "calculator.o",
    src = ":calculator-source[calc.c]",
    headers = [
        ":calculator-source",
        MUSL + ":headers",
    ],
    object_name = "calc.o",
    toolchain = MUSL + ":tcc",
)

c_binary(
    name = "calculator",
    end_objects = [
        MUSL + ":restored-crtn.o",
    ],
    libraries = [
        MUSL + ":restored-libc.a",
        SUPPORT,
        MUSL + ":restored-libc.a",
    ],
    objects = [
        MUSL + ":restored-crt1.o",
        MUSL + ":restored-crti.o",
        ":calculator.o",
    ],
    toolchain = MUSL + ":tcc",
)

[
    command_test(
        name = name,
        args = [
            expression,
            answer,
        ],
        tool = ":calculator",
    )
    for name, expression, answer in [
        ("precedence", "2+3*4", "14"),
        ("parentheses", "(17-2)*3", "45"),
        ("native-long", "1234567890123+17", "1234567890140"),
    ]
]

command_test(
    name = "syntax-error",
    args = [
        "2",
        "$(exe :calculator)",
        "(1+",
        "0",
    ],
    tool = "cellar//bootstrap/stage1/tools:expect-exit",
)

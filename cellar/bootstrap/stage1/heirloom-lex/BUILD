# SPDX-FileCopyrightText: 2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

load("@cellar//bootstrap:actions.bzl", "command_test", "configured_tool", "generate")
load("@cellar//bootstrap:defs.bzl", "export_file", "filegroup")
load("@cellar//bootstrap:source.bzl", "download_file", "untar", "write_file")
load("@cellar//bootstrap/stage1:defs.bzl", "c_binary", "c_library", "c_object")

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

SOURCES = [
    "main.c",
    "sub1.c",
    "sub2.c",
    "sub3.c",
    "header.c",
    "wcio.c",
    "getopt.c",
    "lsearch.c",
]

RUNTIME = [
    "allprint",
    "libmain",
    "reject",
    "yyless",
    "yywrap",
]

FILES = SOURCES + [name + ".c" for name in RUNTIME] + [
    "parser.y",
    "ldefs.c",
    "once.h",
    "sgs.h",
    "search.h",
    "ncform",
    "nceucform",
    "nrform",
    "lex.1",
]

LICENSES = [
    "LICENSE/OPENSOLARIS.LICENSE",
    "LICENSE/CALDERA.LICENSE",
    "LICENSE/BERKELEY.LICENSE",
]

download_file(
    name = "heirloom-devtools-070527.tar.bz2",
    hash = "9f233d8b78e4351fe9dd2d50d83958a0e5af36f54e9818521458a08e058691ba",
    urls = ["https://downloads.sourceforge.net/project/heirloom/heirloom-devtools/070527/heirloom-devtools-070527.tar.bz2"],
)

generate(
    name = "heirloom.tar",
    args = [
        "--file",
        "$(location :heirloom-devtools-070527.tar.bz2)",
        "--output",
    ],
    tool = "cellar//bootstrap/stage0-posix/mescc-tools-extra:unbz2",
)

untar(
    name = "heirloom-devtools-070527",
    chdirenv = "cellar//bootstrap/stage0-posix/cellar-extra:chdirenv",
    files = ["lex/" + path for path in FILES] + LICENSES,
    input = ":heirloom.tar",
    untar = "cellar//bootstrap/stage0-posix/mescc-tools-extra:untar",
)

generate(
    name = "parser",
    args = [
        "-l",
        "-o",
        "parser.c",
        "$(location :heirloom-devtools-070527[lex/parser.y])",
    ],
    chdir = "cellar//bootstrap/stage0-posix/cellar-extra:chdirenv",
    directory = True,
    env = {"TMPDIR": "."},
    files = ["parser.c"],
    tool = "cellar//bootstrap/stage1/oyacc:oyacc",
)

filegroup(
    name = "source",
    srcs = {path: ":heirloom-devtools-070527[lex/" + path + "]" for path in FILES} | {"parser.c": ":parser[parser.c]"} | {path: ":heirloom-devtools-070527[" + path + "]" for path in LICENSES},
)

[
    c_object(
        name = "lex-{}.o".format(i),
        src = ":source[" + path + "]",
        defines = [
            "_GNU_SOURCE=1",
            "unix=1",
            'FORMPATH="/nonexistent-bootstrap-lex"',
        ],
        flags = ["-Werror"],
        headers = [
            ":source",
            MUSL + ":headers",
        ],
        includes = [":source"],
        object_name = "lex{}.o".format(i),
        toolchain = MUSL + ":tcc",
    )
    for i, path in enumerate(SOURCES + ["parser.c"])
]

c_binary(
    name = "lex-bin",
    libraries = LIBC,
    objects = CRT + [":lex-{}.o".format(i) for i in range(len(SOURCES) + 1)] + [MUSL + ":restored-crtn.o"],
    output = "lex",
    toolchain = MUSL + ":tcc",
)

filegroup(
    name = "forms",
    srcs = {name: ":source[" + name + "]" for name in [
        "ncform",
        "nceucform",
        "nrform",
    ]},
)

configured_tool(
    name = "lex",
    args = [
        "-Y",
        "$(location :forms)",
    ],
    tool = ":lex-bin",
)

RUNTIME_VARIANTS = [(name, name, []) for name in RUNTIME] + [(
    name + "_w",
    name,
    [
        "EUC=1",
        "JLSLEX=1",
        "WOPTION=1",
    ],
) for name in [
    "allprint",
    "reject",
    "yyless",
]] + [(
    name + "_e",
    name,
    [
        "EUC=1",
        "JLSLEX=1",
        "EOPTION=1",
    ],
) for name in [
    "reject",
    "yyless",
]]

[
    c_object(
        name = name + ".o",
        src = ":source[" + source + ".c]",
        defines = defines + ["_GNU_SOURCE=1"],
        headers = [
            ":source",
            MUSL + ":headers",
        ],
        includes = [":source"],
        object_name = name + ".o",
        toolchain = MUSL + ":tcc",
    )
    for name, source, defines in RUNTIME_VARIANTS
]

c_library(
    name = "libl.a",
    objects = [":" + name + ".o" for name, _source, _defines in RUNTIME_VARIANTS],
    output = "libl.a",
    toolchain = MUSL + ":tcc",
)

export_file(name = "scanner.l")

generate(
    name = "scanner.c",
    args = [
        "-t",
        "$(location :scanner.l)",
    ],
    capture = "cellar//bootstrap/stage1/tools:capture",
    tool = ":lex",
)

c_object(
    name = "scanner.o",
    src = ":scanner.c",
    headers = [MUSL + ":headers"],
    object_name = "scan.o",
    toolchain = MUSL + ":tcc",
)

c_binary(
    name = "scanner",
    libraries = [":libl.a"] + LIBC,
    objects = CRT + [
        ":scanner.o",
        MUSL + ":restored-crtn.o",
    ],
    toolchain = MUSL + ":tcc",
)

write_file(
    name = "input",
    content = "alpha123 /* skipped999 */ beta42\ngamma7 ?\n",
)

write_file(
    name = "expected",
    content = "3 172 1\n",
)

generate(
    name = "scanned",
    capture = "cellar//bootstrap/stage1/tools:capture",
    stdin = ":input",
    tool = ":scanner",
)

command_test(
    name = "generated-scanner",
    args = [
        "$(location :scanned)",
        "$(location :expected)",
    ],
    tool = "cellar//bootstrap/stage0-posix/cellar-extra:bytecmp",
)

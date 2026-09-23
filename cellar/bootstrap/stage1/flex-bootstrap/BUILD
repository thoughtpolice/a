# SPDX-FileCopyrightText: 2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

load("@cellar//bootstrap:actions.bzl", "command_test", "configured_tool", "generate")
load("@cellar//bootstrap:defs.bzl", "export_file", "filegroup")
load("@cellar//bootstrap:source.bzl", "download_file", "exact_patch", "untar", "write_file")
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

BASE = [
    "ccl",
    "dfa",
    "ecs",
    "gen",
    "main",
    "misc",
    "nfa",
    "sym",
    "tblcmp",
    "yylex",
    "options",
    "scanopt",
    "buf",
]

FILES = [
    "ccl.c",
    "dfa.c",
    "ecs.c",
    "gen.c",
    "main.c",
    "misc.c",
    "nfa.c",
    "sym.c",
    "tblcmp.c",
    "yylex.c",
    "options.c",
    "scanopt.c",
    "buf.c",
    "libmain.c",
    "libyywrap.c",
    "flexdef.h",
    "version.h",
    "options.h",
    "scanopt.h",
    "FlexLexer.h",
    "gettext.h",
    "parse.y",
    "scan.l",
    "flex.skl",
    "mkskel.sh",
    "COPYING",
]

# The handwritten live-bootstrap scanner is consumed only by Heirloom lex.
export_file(name = "scan.lex.l")

[export_file(name = path) for path in glob([
    "patches/*.patch",
])]

download_file(
    name = "flex.tar.gz",
    hash = "68aa10c473b6010ffad680cada09fc4eec6b3cc6e415cc2339e5fc2385ccc142",
    size_bytes = 546284,
    urls = ["https://codeload.github.com/westes/flex/tar.gz/d160f0247ba1611aa59d28f027d6292ba24abb50"],
)

generate(
    name = "flex.tar",
    args = [
        "--file",
        "$(location :flex.tar.gz)",
        "--output",
    ],
    tool = "cellar//bootstrap/stage0-posix/mescc-tools-extra:ungz",
)

untar(
    name = "flex-d160f0247ba1611aa59d28f027d6292ba24abb50",
    chdirenv = "cellar//bootstrap/stage0-posix/cellar-extra:chdirenv",
    files = FILES,
    input = ":flex.tar",
    untar = "cellar//bootstrap/stage0-posix/mescc-tools-extra:untar",
)

exact_patch(
    name = "p0",
    src = ":flex-d160f0247ba1611aa59d28f027d6292ba24abb50[flexdef.h]",
    patch = ":patches/p0.patch",
)

exact_patch(
    name = "p1",
    src = ":p0",
    patch = ":patches/p1.patch",
)

exact_patch(
    name = "p2",
    src = ":flex-d160f0247ba1611aa59d28f027d6292ba24abb50[scan.l]",
    patch = ":patches/p2.patch",
)

exact_patch(
    name = "p3",
    src = ":p2",
    patch = ":patches/p3.patch",
)

exact_patch(
    name = "p4",
    src = ":p3",
    patch = ":patches/p4.patch",
)

exact_patch(
    name = "skel",
    src = ":flex-d160f0247ba1611aa59d28f027d6292ba24abb50[mkskel.sh]",
    patch = ":patches/skel.patch",
)

exact_patch(
    name = "unput",
    src = ":flex-d160f0247ba1611aa59d28f027d6292ba24abb50[flex.skl]",
    patch = ":patches/unput.patch",
)

# Native Linux/musl; no message catalogs or terminal-library dependency.
CONFIG = [
    "HAVE_STRING_H",
    "HAVE_SYS_TYPES_H",
    "STDC_HEADERS",
    "HAVE_STDBOOL_H",
    "HAVE_STRCASECMP",
    "HAVE_UNISTD_H",
    "HAVE_ALLOCA_H",
]

write_file(
    name = "config.h",
    content = "\n".join(["#define " + name + " 1" for name in CONFIG]) + "\n#define _GNU_SOURCE 1\n",
)

filegroup(
    name = "source",
    srcs = {path: ":flex-d160f0247ba1611aa59d28f027d6292ba24abb50[" + path + "]" for path in FILES} | {
        "config.h": ":config.h",
        "flexdef.h": ":p1",
        "scan.l": ":p4",
        "mkskel.sh": ":skel",
        "flex.skl": ":unput",
    },
)

filegroup(
    name = "generator-path",
    srcs = {"sed": "cellar//bootstrap/stage1/sed:sed"},
)

generate(
    name = "skeleton",
    args = [
        "--noprofile",
        "--norc",
        "$(location :source[mkskel.sh])",
        "$(location :source[flex.skl])",
    ],
    capture = "cellar//bootstrap/stage1/tools:capture",
    env = {"PATH": "$(location :generator-path)"},
    tool = "cellar//bootstrap/stage1/bash-bootstrap:bash",
)

generate(
    name = "parser",
    args = [
        "-d",
        "-l",
        "-o",
        "parse.c",
        "$(location :source[parse.y])",
    ],
    chdir = "cellar//bootstrap/stage0-posix/cellar-extra:chdirenv",
    directory = True,
    env = {"TMPDIR": "."},
    files = [
        "parse.c",
        "parse.h",
    ],
    tool = "cellar//bootstrap/stage1/oyacc:oyacc",
)

generate(
    name = "scanner-seed",
    args = [
        "-t",
        "$(location :scan.lex.l)",
    ],
    capture = "cellar//bootstrap/stage1/tools:capture",
    tool = "cellar//bootstrap/stage1/heirloom-lex:lex",
)

filegroup(
    name = "prepared",
    srcs = {path: ":source[" + path + "]" for path in FILES + ["config.h"]} | {
        "parse.c": ":parser[parse.c]",
        "parse.h": ":parser[parse.h]",
        "skel.c": ":skeleton",
    },
)

[
    c_object(
        name = name + ".o",
        src = ":prepared[" + name + ".c]",
        defines = ['VERSION="2.5.11"'],
        flags = ["-Werror"] + ([
            "-include",
            "unistd.h",
        ] if name == "main" else []),
        headers = [
            ":prepared",
            MUSL + ":headers",
        ],
        includes = [":prepared"],
        object_name = "f{}.o".format(i),
        toolchain = MUSL + ":tcc",
    )
    for i, name in enumerate(BASE + [
        "parse",
        "skel",
        "libmain",
        "libyywrap",
    ])
]

[
    [
        c_object(
            name = stage + "-scanner.o",
            src = scanner,
            defines = ["yylex=flexscan"] if stage == "seed" else [],
            flags = ["-Werror"],
            headers = [
                ":prepared",
                MUSL + ":headers",
            ],
            includes = [":prepared"],
            object_name = "scan.o",
            toolchain = MUSL + ":tcc",
        ),
        c_binary(
            name = "flex-" + stage,
            end_objects = [
                MUSL + ":restored-crtn.o",
            ],
            libraries = (["cellar//bootstrap/stage1/heirloom-lex:libl.a"] if stage == "seed" else []) + LIBC,
            objects = CRT + [":" + name + ".o" for name in BASE + [
                "parse",
                "skel",
            ]] + [
                ":" + stage + "-scanner.o",
            ],
            output = "flex",
            toolchain = MUSL + ":tcc",
        ),
    ]
    for stage, scanner in [
        ("seed", ":scanner-seed"),
        ("regenerated", ":scanner-regenerated"),
    ]
]

generate(
    name = "scanner-regenerated",
    args = [
        "-L",
        "-t",
        "$(location :source[scan.l])",
    ],
    capture = "cellar//bootstrap/stage1/tools:capture",
    tool = ":flex-seed",
)

c_library(
    name = "libfl.a",
    objects = [
        ":libmain.o",
        ":libyywrap.o",
    ],
    output = "libfl.a",
    toolchain = MUSL + ":tcc",
)

command_test(
    name = "version",
    args = ["--version"],
    tool = ":flex-regenerated",
)

# Both bootstrap generations must produce the same scanner from the same input.
generate(
    name = "scanner-again",
    args = [
        "-L",
        "-t",
        "$(location :source[scan.l])",
    ],
    capture = "cellar//bootstrap/stage1/tools:capture",
    tool = ":flex-regenerated",
)

command_test(
    name = "scanner-regeneration",
    args = [
        "$(location :scanner-regenerated)",
        "$(location :scanner-again)",
    ],
    tool = "cellar//bootstrap/stage0-posix/cellar-extra:bytecmp",
)

[export_file(name = name + ".l") for name in [
    "scanner",
    "reentrant",
    "runtime",
]]

[
    [
        generate(
            name = name + ".c",
            args = [
                "-L",
                "-t",
            ] + flags + ["$(location :" + input + ".l)"],
            capture = "cellar//bootstrap/stage1/tools:capture",
            tool = ":flex-regenerated",
        ),
        c_object(
            name = name + "-test.o",
            src = ":" + name + ".c",
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
            libraries = [":libfl.a"] + LIBC,
            objects = CRT + [
                ":" + name + "-test.o",
            ],
            toolchain = MUSL + ":tcc",
        ),
    ]
    for name, input, flags in [
        ("compressed", "scanner", []),
        (
            "full",
            "scanner",
            ["-Cf"],
        ),
        (
            "fast",
            "scanner",
            ["-CF"],
        ),
        ("reentrant", "reentrant", []),
        ("runtime", "runtime", []),
    ]
]

[command_test(
    name = name,
    tool = ":" + name + "-test-bin",
) for name in [
    "compressed",
    "full",
    "fast",
    "reentrant",
]]

write_file(
    name = "runtime-input",
    content = "alpha 123 beta 42\n",
)

write_file(
    name = "runtime-expected",
    content = "word:alpha\nnumber:123\nword:beta\nnumber:42\n",
)

generate(
    name = "runtime-output",
    capture = "cellar//bootstrap/stage1/tools:capture",
    stdin = ":runtime-input",
    tool = ":runtime-test-bin",
)

command_test(
    name = "runtime",
    args = [
        "$(location :runtime-output)",
        "$(location :runtime-expected)",
    ],
    tool = "cellar//bootstrap/stage0-posix/cellar-extra:bytecmp",
)

configured_tool(
    name = "flex",
    tool = ":flex-regenerated",
)

write_file(
    name = "malformed.l",
    content = "%%\n[unterminated  return 1;\n%%\n",
)

command_test(
    name = "diagnostic",
    args = [
        "1",
        "$(exe :flex-regenerated)",
        "-t",
        "$(location :malformed.l)",
    ],
    tool = "cellar//bootstrap/stage1/tools:expect-exit",
)

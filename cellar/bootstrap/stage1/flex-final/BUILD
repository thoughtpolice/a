# SPDX-FileCopyrightText: 2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

load("@cellar//bootstrap:actions.bzl", "command_test", "concatenate", "configured_tool", "generate")
load("@cellar//bootstrap:defs.bzl", "export_file", "filegroup")
load("@cellar//bootstrap:source.bzl", "write_file")
load("@cellar//bootstrap/stage1:defs.bzl", "c_binary", "c_library", "c_object")

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

BASH = "cellar//bootstrap/stage1/bash:bash"

M4 = "cellar//bootstrap/stage1/m4-final:m4-bin"

BASE = [
    "buf",
    "ccl",
    "dfa",
    "ecs",
    "filter",
    "gen",
    "main",
    "misc",
    "nfa",
    "options",
    "regex",
    "scanflags",
    "scanopt",
    "sym",
    "tables",
    "tables_shared",
    "tblcmp",
    "yylex",
]

FILES = [
    "buf.c",
    "ccl.c",
    "dfa.c",
    "ecs.c",
    "filter.c",
    "gen.c",
    "main.c",
    "misc.c",
    "nfa.c",
    "options.c",
    "regex.c",
    "scanflags.c",
    "scanopt.c",
    "sym.c",
    "tables.c",
    "tables_shared.c",
    "tblcmp.c",
    "yylex.c",
    "libmain.c",
    "libyywrap.c",
    "flexdef.h",
    "flexint.h",
    "version.h",
    "options.h",
    "scanopt.h",
    "FlexLexer.h",
    "gettext.h",
    "tables.h",
    "tables_shared.h",
    "parse.y",
    "scan.l",
    "flex.skl",
    "mkskel.sh",
]

# Native Linux/musl, POSIX regex, no message catalogs or curses dependency.
CONFIG = [
    "HAVE_ASSERT_H",
    "HAVE_LIMITS_H",
    "HAVE_NETINET_IN_H",
    "HAVE_DECL___FUNC__",
    "HAVE_INTTYPES_H",
    "HAVE_STDINT_H",
    "HAVE_STDBOOL_H",
    "HAVE_UNISTD_H",
    "STDC_HEADERS",
]

write_file(
    name = "config.h",
    content = "\n".join(["#define " + name + " 1" for name in CONFIG]) + "\n",
)

filegroup(
    name = "source",
    srcs = {path: "cellar//bootstrap/stage1/flex:source[" + path + "]" for path in FILES} | {
        "COPYING": "cellar//bootstrap/stage1/flex:source[COPYING]",
        "config.h": ":config.h",
    },
)

filegroup(
    name = "generator-path",
    srcs = {"sed": "cellar//bootstrap/stage1/sed-final:sed-bin"},
)

configured_tool(
    name = "skeleton-command",
    args = [
        "skel.c",
        "$(location " + BASH + ")",
        "--noprofile",
        "--norc",
        "-e",
        "$(location :source[mkskel.sh])",
        "$(location :source)",
        "$(location " + M4 + ")",
        "2.6.4",
    ],
    env = {
        "PATH": "$(location :generator-path)",
        "BOOTSTRAP_SHELL": "$(location " + BASH + ")",
        "CELLAR_BOOTSTRAP_IDENTITY": "1",
    },
    env_tool = "cellar//bootstrap/stage1/tools:withenv",
    tool = "cellar//bootstrap/stage1/tools:capture",
)

generate(
    name = "skeleton",
    chdir = "cellar//bootstrap/stage0-posix/cellar-extra:chdirenv",
    directory = True,
    env = {"TMPDIR": "."},
    files = ["skel.c"],
    tool = ":skeleton-command",
)

generate(
    name = "parser",
    args = [
        "-d",
        "-l",
        "-o",
        "parse.c",
        "source/parse.y",
    ],
    chdir = "cellar//bootstrap/stage0-posix/cellar-extra:chdirenv",
    directory = True,
    env = {"TMPDIR": "."},
    files = [
        "parse.c",
        "parse.h",
    ],
    source_alias = SOURCE_ALIAS,
    source_tree = ":source",
    tool = "cellar//bootstrap/stage1/oyacc:oyacc",
)

write_file(
    name = "yylval.h",
    content = "\nextern int yylval;\n",
)

concatenate(
    name = "parse.h",
    inputs = [
        ":parser[parse.h]",
        ":yylval.h",
    ],
    tool = "cellar//bootstrap/stage0-posix/mescc-tools-extra:catm",
)

filegroup(
    name = "prepared",
    srcs = {path: ":source[" + path + "]" for path in FILES + [
        "config.h",
        "COPYING",
    ]} | {
        "parse.c": ":parser[parse.c]",
        "parse.h": ":parse.h",
        "skel.c": ":skeleton[skel.c]",
    },
)

[
    c_object(
        name = name + ".o",
        src = ":prepared[" + name + ".c]",
        defines = [
            "HAVE_CONFIG_H=1",
            "_GNU_SOURCE=1",
            'VERSION="2.6.4"',
        ],
        flags = [
            "-O2",
            "-Werror",
            "-x",
            "c",
        ],
        headers = [
            ":prepared",
            MUSL + ":headers",
        ],
        logical_includes = ["."],
        logical_source = name + ".c",
        object_name = "f{}.o".format(i),
        source_alias = SOURCE_ALIAS,
        source_tree = ":prepared",
        toolchain = CC,
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
        filegroup(
            name = stage + "-source",
            srcs = {
                "scan.c": ":" + stage + "-scanner",
                "include": ":prepared",
            },
        ),
        c_object(
            name = stage + "-scan.o",
            src = ":" + stage + "-scanner",
            defines = [
                "HAVE_CONFIG_H=1",
                "_GNU_SOURCE=1",
            ],
            flags = [
                "-O2",
                "-Werror",
                "-x",
                "c",
            ],
            headers = [
                ":prepared",
                MUSL + ":headers",
            ],
            logical_includes = ["include"],
            logical_source = "scan.c",
            object_name = "scan.o",
            source_alias = SOURCE_ALIAS,
            source_tree = ":" + stage + "-source",
            toolchain = CC,
        ),
        c_binary(
            name = "flex-" + stage + "-bin",
            libraries = LIBC,
            objects = CRT + [":" + name + ".o" for name in BASE + [
                "parse",
                "skel",
            ]] + [
                ":" + stage + "-scan.o",
            ] + CRTN,
            output = "flex",
            toolchain = CC,
        ),
        configured_tool(
            name = "flex-" + stage,
            env = {
                "M4": "$(location " + M4 + ")",
                "BOOTSTRAP_SHELL": "$(location " + BASH + ")",
                "CELLAR_BOOTSTRAP_IDENTITY": "1",
            },
            env_tool = "cellar//bootstrap/stage1/tools:withenv",
            tool = ":flex-" + stage + "-bin",
        ),
    ]
    for stage in [
        "initial",
        "regenerated",
    ]
]

[
    generate(
        name = stage + "-scanner",
        args = [
            "-L",
            "-t",
            "scan.l",
        ],
        capture = "cellar//bootstrap/stage1/tools:capture",
        output = "scan.c",
        tool = predecessor,
        working_directory = ":source",
    )
    for stage, predecessor in [
        ("initial", "cellar//bootstrap/stage1/flex:flex"),
        ("regenerated", ":flex-initial"),
        ("again", ":flex-regenerated"),
    ]
]

configured_tool(
    name = "flex",
    tool = ":flex-regenerated",
)

c_library(
    name = "libfl.a",
    objects = [
        ":libmain.o",
        ":libyywrap.o",
    ],
    output = "libfl.a",
    toolchain = CC,
)

command_test(
    name = "version",
    args = ["--version"],
    tool = ":flex",
)

command_test(
    name = "scanner-regeneration",
    args = [
        "$(location :regenerated-scanner)",
        "$(location :again-scanner)",
    ],
    tool = "cellar//bootstrap/stage0-posix/cellar-extra:bytecmp",
)

[
    [
        generate(
            name = name + ".c",
            args = [
                "-L",
                "-t",
            ] + flags + ["$(location cellar//bootstrap/stage1/flex-bootstrap:" + input + ".l)"],
            capture = "cellar//bootstrap/stage1/tools:capture",
            tool = ":flex",
        ),
        c_object(
            name = name + "-test.o",
            src = ":" + name + ".c",
            flags = [
                "-O2",
                "-Werror",
                "-x",
                "c",
            ],
            headers = [MUSL + ":headers"],
            object_name = "test.o",
            toolchain = CC,
        ),
        c_binary(
            name = name + "-test-bin",
            libraries = [":libfl.a"] + LIBC,
            objects = CRT + [
                ":" + name + "-test.o",
            ] + CRTN,
            toolchain = CC,
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

command_test(
    name = "diagnostic",
    args = [
        "1",
        "$(location cellar//bootstrap/stage1/tools:withenv)",
        "M4=$(location " + M4 + ")",
        "--",
        "$(location :flex-regenerated-bin)",
        "-t",
        "$(location cellar//bootstrap/stage1/flex-bootstrap:malformed.l)",
    ],
    tool = "cellar//bootstrap/stage1/tools:expect-exit",
)

command_test(
    name = "missing-m4",
    args = [
        "1",
        "$(location :flex-regenerated-bin)",
        "-t",
        "$(location cellar//bootstrap/stage1/flex-bootstrap:scanner.l)",
    ],
    env = {"M4": ""},
    tool = "cellar//bootstrap/stage1/tools:expect-exit",
)

generate(
    name = "api",
    args = [
        "-L",
        "-o",
        "api.c",
        "--header-file=api.h",
        "--tables-file=api.tables",
        "$(location cellar//bootstrap/stage1/flex:api.l)",
    ],
    chdir = "cellar//bootstrap/stage0-posix/cellar-extra:chdirenv",
    directory = True,
    env = {"TMPDIR": "."},
    files = [
        "api.c",
        "api.h",
        "api.tables",
    ],
    tool = ":flex",
)

[
    c_object(
        name = name + ".o",
        src = src,
        flags = [
            "-O2",
            "-Werror",
            "-x",
            "c",
        ],
        headers = [
            ":api",
            MUSL + ":headers",
        ],
        includes = [":api"],
        object_name = name + ".o",
        toolchain = CC,
    )
    for name, src in [
        ("api", ":api[api.c]"),
        ("api-test", "cellar//bootstrap/stage1/flex:api-test.c"),
    ]
]

c_binary(
    name = "api-test-bin",
    libraries = LIBC,
    objects = CRT + [
        ":api.o",
        ":api-test.o",
    ] + CRTN,
    toolchain = CC,
)

command_test(
    name = "header-and-external-tables",
    args = ["$(location :api[api.tables])"],
    tool = ":api-test-bin",
)

export_file(name = "cpp.l")

generate(
    name = "cpp-scanner",
    args = [
        "-L",
        "-+",
        "-o",
        "scanner.cc",
        "$(location :cpp.l)",
    ],
    chdir = "cellar//bootstrap/stage0-posix/cellar-extra:chdirenv",
    directory = True,
    files = ["scanner.cc"],
    tool = ":flex",
)

filegroup(
    name = "cpp-source",
    srcs = {
        "scanner.cc": ":cpp-scanner[scanner.cc]",
        "FlexLexer.h": ":source[FlexLexer.h]",
    },
)

generate(
    name = "cpp-program",
    args = [
        "-O2",
        "-g0",
        "-frandom-seed=bootstrap",
        "-Werror",
        "-Isource",
        "source/scanner.cc",
        "-o",
        "program",
    ],
    chdir = "cellar//bootstrap/stage0-posix/cellar-extra:chdirenv",
    directory = True,
    files = ["program"],
    source_alias = SOURCE_ALIAS,
    source_tree = ":cpp-source",
    tool = "cellar//bootstrap/stage1/libstdcxx:stage3-g++",
)

command_test(
    name = "cpp-scanner-runtime",
    args = [
        "0",
        "$(location :cpp-program[program])",
    ],
    tool = "cellar//bootstrap/stage1/tools:expect-exit",
)

filegroup(
    name = "installation",
    srcs = {
        "bin/flex": ":flex-regenerated-bin",
        "lib/libfl.a": ":libfl.a",
        "include/FlexLexer.h": ":source[FlexLexer.h]",
        "share/licenses/flex/COPYING": ":source[COPYING]",
    },
)

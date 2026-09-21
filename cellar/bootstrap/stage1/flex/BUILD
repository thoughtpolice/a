# SPDX-FileCopyrightText: 2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

load("@cellar//bootstrap:actions.bzl", "command_test", "concatenate", "configured_tool", "generate")
load("@cellar//bootstrap:defs.bzl", "export_file", "filegroup")
load("@cellar//bootstrap:source.bzl", "download_file", "untar", "write_file")
load("@cellar//bootstrap/stage1:defs.bzl", "c_binary", "c_library", "c_object")

MUSL = "cellar//bootstrap/stage1/musl"

BASH = "cellar//bootstrap/stage1/bash-bootstrap:bash"

M4 = "cellar//bootstrap/stage1/m4:m4-bin"

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

[export_file(name = path) for path in glob([
    "patches/*.before",
    "patches/*.after",
])]

download_file(
    name = "flex-2.6.4.tar.gz",
    hash = "e87aae032bf07c26f85ac0ed3250998c37621d95f8bd748b31f15b33c45ee995",
    urls = ["https://github.com/westes/flex/releases/download/v2.6.4/flex-2.6.4.tar.gz"],
)

generate(
    name = "flex.tar",
    args = [
        "--file",
        "$(location :flex-2.6.4.tar.gz)",
        "--output",
    ],
    tool = "cellar//bootstrap/stage0-posix/mescc-tools-extra:ungz",
)

untar(
    name = "flex-2.6.4",
    chdirenv = "cellar//bootstrap/stage0-posix/cellar-extra:chdirenv",
    files = ["src/" + path for path in FILES] + ["COPYING"],
    input = ":flex.tar",
    untar = "cellar//bootstrap/stage0-posix/mescc-tools-extra:untar",
)

generate(
    name = "main-source",
    args = [
        "$(location :flex-2.6.4[src/main.c])",
        "$(location :patches/m4.before)",
        "$(location :patches/m4.after)",
    ],
    tool = "cellar//bootstrap/stage1/simple-patch:simple-patch",
)

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
    srcs = {path: ":flex-2.6.4[src/" + path + "]" for path in FILES} | {
        "COPYING": ":flex-2.6.4[COPYING]",
        "config.h": ":config.h",
        "main.c": ":main-source",
    },
)

filegroup(
    name = "generator-path",
    srcs = {"sed": "cellar//bootstrap/stage1/sed:sed"},
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
        flags = ["-Werror"],
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
            name = stage + "-scan.o",
            src = ":" + stage + "-scanner",
            defines = [
                "HAVE_CONFIG_H=1",
                "_GNU_SOURCE=1",
            ],
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
            name = "flex-" + stage + "-bin",
            libraries = LIBC,
            objects = CRT + [":" + name + ".o" for name in BASE + [
                "parse",
                "skel",
            ]] + [
                ":" + stage + "-scan.o",
                MUSL + ":restored-crtn.o",
            ],
            output = "flex",
            toolchain = MUSL + ":tcc",
        ),
        configured_tool(
            name = "flex-" + stage,
            env = {
                "M4": "$(location " + M4 + ")",
                "BOOTSTRAP_SHELL": "$(location " + BASH + ")",
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
            "$(location :source[scan.l])",
        ],
        capture = "cellar//bootstrap/stage1/tools:capture",
        tool = predecessor,
    )
    for stage, predecessor in [
        ("initial", "cellar//bootstrap/stage1/flex-bootstrap:flex"),
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
    toolchain = MUSL + ":tcc",
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
            flags = ["-Werror"],
            headers = [MUSL + ":headers"],
            object_name = "test.o",
            toolchain = MUSL + ":tcc",
        ),
        c_binary(
            name = name + "-test-bin",
            libraries = [":libfl.a"] + LIBC,
            objects = CRT + [
                ":" + name + "-test.o",
                MUSL + ":restored-crtn.o",
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

export_file(name = "api.l")

generate(
    name = "api",
    args = [
        "-L",
        "-o",
        "api.c",
        "--header-file=api.h",
        "--tables-file=api.tables",
        "$(location :api.l)",
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
        flags = ["-Werror"],
        headers = [
            ":api",
            MUSL + ":headers",
        ],
        includes = [":api"],
        object_name = name + ".o",
        toolchain = MUSL + ":tcc",
    )
    for name, src in [
        ("api", ":api[api.c]"),
        ("api-test", "api-test.c"),
    ]
]

c_binary(
    name = "api-test-bin",
    libraries = LIBC,
    objects = CRT + [
        ":api.o",
        ":api-test.o",
        MUSL + ":restored-crtn.o",
    ],
    toolchain = MUSL + ":tcc",
)

command_test(
    name = "header-and-external-tables",
    args = ["$(location :api[api.tables])"],
    tool = ":api-test-bin",
)

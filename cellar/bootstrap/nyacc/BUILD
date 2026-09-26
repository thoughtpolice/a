# SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

load("@cellar//bootstrap:actions.bzl", "generate")
load("@cellar//bootstrap:defs.bzl", "filegroup")
load("@cellar//bootstrap:source.bzl", "download_file", "replace", "ungz", "untar")
load(":sources.bzl", "NYACC_MODULES")

# The NYACC release that live-bootstrap dd8ac27bf959344b9bcf5e876bdd7716879bbc70
# lists in mes-0.27/sources. Its archive's top directory is nyacc-1.00.2.
VERSION = "1.00.2-lb1"

TOOLS = "cellar//bootstrap/stage0-posix/mescc-tools-extra"

MES = "cellar//bootstrap/mes"

TABLES = {
    "cpp": [
        "cpp-act.scm",
        "cpp-tab.scm",
    ],
    "c99": [
        "c99-act.scm",
        "c99-tab.scm",
        "c99x-act.scm",
        "c99x-tab.scm",
    ],
    "c99cx": [
        "c99cx-act.scm",
        "c99cx-tab.scm",
    ],
}

download_file(
    name = "nyacc-{}.tar.gz".format(VERSION),
    hash = "708c943f89c972910e9544ee077771acbd0a2c0fc6d33496fe158264ddb65327",
    urls = ["https://github.com/Googulator/nyacc/releases/download/V{0}/nyacc-{0}.tar.gz".format(VERSION)],
)

ungz(
    name = "nyacc-{}.tar".format(VERSION),
    input = ":nyacc-{}.tar.gz".format(VERSION),
    ungz = TOOLS + ":ungz",
)

untar(
    name = "nyacc-1.00.2",
    files = NYACC_MODULES + ["gen-{}-files.scm".format(grammar) for grammar in TABLES],
    input = ":nyacc-{}.tar".format(VERSION),
    untar = TOOLS + ":untar",
)

HANDWRITTEN = {path: ":nyacc-1.00.2[{}]".format(path) for path in NYACC_MODULES}

filegroup(
    name = "handwritten",
    srcs = HANDWRITTEN,
)

# The original generator entry points write beneath PATH/mach.d. Buck gives
# each invocation a fresh mach.d output directory; '..' selects that directory.
[
    replace(
        name = "gen-{}-files.scm".format(grammar),
        src = ":nyacc-1.00.2[gen-{}-files.scm]".format(grammar),
        after = "..",
        before = "module/nyacc/lang/c99",
        tool = TOOLS + ":replace",
    )
    for grammar in TABLES
]

filegroup(
    name = "with-cpp",
    srcs = HANDWRITTEN | {
        "module/nyacc/lang/c99/mach.d/" + path: ":cpp[{}]".format(path)
        for path in TABLES["cpp"]
    },
)

[
    generate(
        name = grammar,
        args = ["$(location :gen-{}-files.scm)".format(grammar)],
        chdir = True,
        directory = True,
        env = {
            "MES_PREFIX": "$(location " + MES + ":mes-src)",
            "GUILE_LOAD_PATH": "$(location " + MES + ":mes-src)/mes/module:$(location " + MES + ":mes-src)/module:$(location " + modules + ")/module",
            "MES_ARENA": arena,
            "MES_MAX_ARENA": arena,
            "MES_STACK": "6000000",
        },
        files = TABLES[grammar],
        output = "work/mach.d",
        tool = MES + ":mes.bin",
    )
    for grammar, modules, arena in [
        ("cpp", ":handwritten", "20000000"),
        ("c99", ":with-cpp", "32000000"),
        ("c99cx", ":handwritten", "20000000"),
    ]
]

filegroup(
    name = "modules",
    srcs = HANDWRITTEN | {
        "module/nyacc/lang/c99/mach.d/" + path: ":{}[{}]".format(grammar, path)
        for grammar in TABLES
        for path in TABLES[grammar]
    },
)

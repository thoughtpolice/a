# SPDX-FileCopyrightText: © 2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

load("@cellar//bootstrap:actions.bzl", "command_test", "configured_tool", "generate")
load("@cellar//bootstrap:defs.bzl", "filegroup")
load("@cellar//bootstrap/stage1:defs.bzl", "c_binary", "c_object")
load(":sources.bzl", "CORE", "SCANNERS")

MUSL = "cellar//bootstrap/stage1/musl"

# One Bison 3.4.1 executable, `bison-<name>`, compiled around the parser C
# file and header in `parser` and checked on the calculator grammar. `files`
# are the prepared sources the pass shares with the others.
def bison_pass(name, files, parser):
    filegroup(
        name = name + "-source",
        srcs = {path: ":source[" + path + "]" for path in files} | parser | {
            "src/" + scanner + ".c": ":" + scanner
            for scanner in SCANNERS
        },
    )
    units = CORE + ["parse-gram"] + [scanner + "-c" for scanner in SCANNERS]
    for i, unit in enumerate(units):
        c_object(
            name = name + "-{}.o".format(i),
            src = ":" + name + "-source[src/" + unit + ".c]",
            flags = [
                "-Werror",
                "-include",
                "native-declarations.h",
            ],
            headers = [
                ":" + name + "-source",
                MUSL + ":headers",
            ],
            includes = [
                ":" + name + "-source",
                ":" + name + "-source[lib]",
                ":" + name + "-source[src]",
            ],
            object_name = "c{}.o".format(i),
            toolchain = MUSL + ":tcc",
        )
    c_binary(
        name = "bison-" + name + "-bin",
        libraries = [":libbison.a"],
        objects = [":" + name + "-{}.o".format(i) for i in range(len(units))],
        output = "bison",
        runtime = MUSL + ":tcc-link-runtime",
        toolchain = MUSL + ":tcc",
    )
    configured_tool(
        name = "bison-" + name,
        env = {
            "M4": "$(exe cellar//bootstrap/stage1/m4:m4-bin)",
            "BOOTSTRAP_SHELL": "$(exe cellar//bootstrap/stage1/bash-bootstrap:bash)",
            "BISON_PKGDATADIR": "$(location :data)",
        },
        tool = ":bison-" + name + "-bin",
    )
    command_test(
        name = name + "-version",
        args = ["--version"],
        tool = ":bison-" + name,
    )
    generate(
        name = name + "-calculator",
        args = [
            "--no-lines",
            "--defines=calculator.h",
            "-o",
            "calculator.c",
            "$(location :calculator.y)",
        ],
        chdir = True,
        directory = True,
        env = {
            "TMPDIR": ".",
            "LC_ALL": "C.UTF-8",
        },
        files = [
            "calculator.c",
            "calculator.h",
        ],
        tool = ":bison-" + name,
    )
    c_object(
        name = name + "-calculator.o",
        src = ":" + name + "-calculator[calculator.c]",
        flags = ["-Werror"],
        headers = [
            ":" + name + "-calculator",
            MUSL + ":headers",
        ],
        includes = [":" + name + "-calculator"],
        object_name = "calc.o",
        toolchain = MUSL + ":tcc",
    )
    c_binary(
        name = name + "-calculator-bin",
        objects = [":" + name + "-calculator.o"],
        runtime = MUSL + ":tcc-link-runtime",
        toolchain = MUSL + ":tcc",
    )
    for test, expression, value in [
        ("precedence", "4+7*3", "25"),
        ("parentheses", "(4+7)*3", "33"),
        ("native-values", "4294967296+17", "4294967313"),
    ]:
        command_test(
            name = name + "-" + test,
            args = [
                expression,
                value,
            ],
            tool = ":" + name + "-calculator-bin",
        )
    command_test(
        name = name + "-syntax-error",
        args = [
            "2",
            "$(exe :" + name + "-calculator-bin)",
            "3+)",
            "0",
        ],
        tool = "cellar//bootstrap/stage1/tools:expect-exit",
    )

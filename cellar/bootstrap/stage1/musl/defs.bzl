# SPDX-FileCopyrightText: © 2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

load("@cellar//bootstrap:actions.bzl", "command_test", "generate")
load("@cellar//bootstrap/stage1:defs.bzl", "bootstrap_artifact", "c_binary", "c_library", "c_object", "link_runtime", "sysroot")
load(":sources.bzl", "CRT_SOURCES")

MUSL = "cellar//bootstrap/stage1/musl"

# musl keeps every function in libc.a and installs these as empty archives.
EMPTY_LIBRARIES = [
    "m",
    "rt",
    "pthread",
    "crypt",
    "util",
    "xnet",
    "resolv",
    "dl",
]

# Assembles `src` with GNU as into `output`, then declares the result as an
# object for the stage1 rules. `action` names the assembly step.
def gnu_as_object(name, action, src, output, assembler):
    generate(
        name = action,
        args = [
            "--64",
            "$(location " + src + ")",
            "-o",
        ],
        output = output,
        tool = assembler,
    )
    bootstrap_artifact(
        name = name,
        src = ":" + action,
        abi = "x86_64-sysv",
        kind = "object",
        object_format = "elf64-x86-64",
    )

# The libraries and CRT objects of musl pass `libc` with TCC's `libtcc1`, as
# the sysroot `runtime-<name>` that a TCC toolchain passes with -B, and as
# `<name>-link-runtime` for the programs it links.
def musl_runtime(name, libc, libtcc1):
    sysroot(
        name = "runtime-" + name,
        abi = "x86_64-sysv",
        files = {"include": MUSL + ":headers"},
        libraries = {
            "lib/lib" + library + ".a": MUSL + ":" + libc + "-lib" + library + ".a"
            for library in ["c"] + EMPTY_LIBRARIES
        } | {"lib/libtcc1.a": libtcc1},
        object_format = "elf64-x86-64",
        objects = {"lib/" + crt + ".o": MUSL + ":" + libc + "-" + crt + ".o" for crt in [
            "crt1",
            "crti",
            "crtn",
        ]},
    )
    link_runtime(
        name = name + "-link-runtime",
        end_objects = [MUSL + ":" + libc + "-crtn.o"],
        libraries = [
            MUSL + ":" + libc + "-libc.a",
            libtcc1,
            MUSL + ":" + libc + "-libc.a",
        ],
        start_objects = [
            MUSL + ":" + libc + "-crt1.o",
            MUSL + ":" + libc + "-crti.o",
        ],
    )

# One build of musl 1.1.24 from the prepared source `tree`: `<name>-libc.a`,
# the CRT objects, the empty compatibility archives and their `musl_runtime`
# with TCC's `libtcc1`. Given an `assembler`, the pass assembles every source
# that is not C with it instead of `toolchain`. The runtime, threads, fenv and
# syscalls programs, plus `extra_tests`, run against the result.
def musl_pass(name, toolchain, libtcc1, sources, tree, extra_tests = [], assembler = None):
    # do not sort: native and internal headers override public headers.
    includes = [
        tree + "[arch/x86_64]",
        tree + "[arch/generic]",
        tree + "[src/include]",
        tree + "[src/internal]",
        tree + "[include]",
    ]
    for i, path in enumerate(sources):
        if assembler and not path.endswith(".c"):
            gnu_as_object(
                name = name + "-libc-{}.o".format(i),
                action = name + "-asm-{}".format(i),
                assembler = assembler,
                output = "m{}.o".format(i),
                src = tree + "[" + path + "]",
            )
        else:
            c_object(
                name = name + "-libc-{}.o".format(i),
                src = tree + "[{}]".format(path),
                defines = ["_XOPEN_SOURCE=700"],
                flags = [
                    "-std=c99",
                    "-ffreestanding",
                    "-Werror",
                ],
                headers = [tree],
                includes = includes,
                object_name = "m{}.o".format(i),
                toolchain = toolchain,
            )
    if assembler:
        gnu_as_object(
            name = name + "-syscall.o",
            action = name + "-syscall-asm",
            assembler = assembler,
            output = "syscall.o",
            src = MUSL + ":runtime/syscall.S",
        )
    else:
        c_object(
            name = name + "-syscall.o",
            src = MUSL + ":runtime/syscall.S",
            object_name = "syscall.o",
            toolchain = toolchain,
        )
    c_library(
        name = name + "-libc.a",
        objects = [":" + name + "-libc-{}.o".format(i) for i in range(len(sources))] + [":" + name + "-syscall.o"],
        output = "libc.a",
        toolchain = toolchain,
    )
    for path in CRT_SOURCES:
        file = path.rsplit("/", 1)[1]
        crt = file.rsplit(".", 1)[0]
        if assembler and not path.endswith(".c"):
            gnu_as_object(
                name = name + "-" + crt + ".o",
                action = name + "-" + file + "-asm",
                assembler = assembler,
                output = crt + ".o",
                src = tree + "[" + path + "]",
            )
        else:
            c_object(
                name = name + "-" + crt + ".o",
                src = tree + "[{}]".format(path),
                defines = [
                    "CRT=1",
                    "_XOPEN_SOURCE=700",
                ],
                headers = [tree],
                includes = includes,
                object_name = crt + ".o",
                toolchain = toolchain,
            )
    for library in EMPTY_LIBRARIES:
        c_library(
            name = name + "-lib" + library + ".a",
            objects = [],
            output = "lib" + library + ".a",
            toolchain = toolchain,
        )
    musl_runtime(
        name = name,
        libc = name,
        libtcc1 = libtcc1,
    )
    for test in [
        "runtime",
        "threads",
        "fenv",
        "syscalls",
    ] + extra_tests:
        c_object(
            name = name + "-" + test + "-test.o",
            src = MUSL + ":tests/" + test + ".c",
            headers = [MUSL + ":headers"],
            includes = [MUSL + ":headers"],
            object_name = test + ".o",
            toolchain = toolchain,
        )
        c_binary(
            name = name + "-" + test + "-program",
            objects = [":" + name + "-" + test + "-test.o"],
            runtime = ":" + name + "-link-runtime",
            toolchain = toolchain,
        )
        if test == "runtime":
            command_test(
                name = name + "-runtime",
                args = [
                    "startup",
                    "ok",
                ],
                env = {"BOOTSTRAP_TEST": "present"},
                tool = ":" + name + "-runtime-program",
            )
        else:
            command_test(
                name = name + "-" + test,
                tool = ":" + name + "-" + test + "-program",
            )

# SPDX-FileCopyrightText: © 2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

load("@cellar//bootstrap:actions.bzl", "command_test", "generate")
load("@cellar//bootstrap/stage1:defs.bzl", "c_binary", "c_object")
load("@cellar//bootstrap/stage1/musl:defs.bzl", "musl_runtime")
load("@cellar//bootstrap/stage1/tcc:defs.bzl", "tcc_toolchain")
load("@cellar//bootstrap/stage1/tcc-release:defs.bzl", "release_defines", "release_libtcc1", "release_tcc")

MUSL = "cellar//bootstrap/stage1/musl"

RELEASE = "cellar//bootstrap/stage1/tcc-release"

MUSL_INCLUDES = [
    "-nostdinc",
    "-I",
    "$(location " + MUSL + ":headers)",
]

# One musl-linked build of TCC 0.9.27. The `predecessor` compiler, itself
# linked against `predecessor_runtime`, compiles the release and its support
# library against `sysroot` and links `tcc-<name>` with the matching
# `link_runtime`. The new toolchain `<name>` builds against musl pass `libc`
# and the new support library, and the driver, version and runtime checks run
# what it builds.
def musl_tcc(name, predecessor, predecessor_runtime, sysroot, link_runtime, libc):
    tcc_toolchain(
        name = name + "-predecessor",
        cflags = MUSL_INCLUDES,
        execution_runtime = predecessor_runtime,
        sysroot = sysroot,
        tcc = predecessor,
    )
    release_tcc(
        name = name,
        defines = release_defines("/musl/loader"),
        headers = [
            RELEASE + ":source",
            MUSL + ":headers",
        ],
        includes = [RELEASE + ":source"],
        runtime = link_runtime,
        toolchain = ":" + name + "-predecessor",
    )
    release_libtcc1(
        name = name,
        headers = [MUSL + ":headers"],
        toolchain = ":" + name + "-predecessor",
    )
    musl_runtime(
        name = name,
        libc = libc,
        libtcc1 = ":" + name + "-libtcc1.a",
    )
    tcc_toolchain(
        name = name,
        cflags = MUSL_INCLUDES,
        execution_runtime = MUSL + ":runtime-" + libc,
        sysroot = ":runtime-" + name,
        tcc = ":tcc-" + name,
    )

    # The driver alone finds the CRT objects, libc and libtcc1 in the sysroot.
    generate(
        name = name + "-driver-program",
        args = [
            "$(location " + MUSL + ":test-source[tests/runtime.c])",
            "-o",
        ],
        output = "driver-program",
        tool = ":" + name,
    )
    command_test(
        name = name + "-driver",
        args = [
            "0",
            "$(location :" + name + "-driver-program)",
            "startup",
            "ok",
        ],
        env = {"BOOTSTRAP_TEST": "present"},
        tool = "cellar//bootstrap/stage1/tools:expect-exit",
    )
    command_test(
        name = name + "-version",
        args = ["-version"],
        tool = ":tcc-" + name,
    )
    for test in [
        "headers",
        "runtime",
        "threads",
        "fenv",
        "syscalls",
    ]:
        c_object(
            name = name + "-" + test + "-test.o",
            src = MUSL + ":test-source[tests/" + test + ".c]",
            headers = [MUSL + ":headers"],
            object_name = test + ".o",
            toolchain = ":" + name,
        )
        c_binary(
            name = name + "-" + test + "-program",
            objects = [":" + name + "-" + test + "-test.o"],
            runtime = ":" + name + "-link-runtime",
            toolchain = ":" + name,
        )
        command_test(
            name = name + "-" + test,
            args = [
                "startup",
                "ok",
            ] if test == "runtime" else [],
            env = {"BOOTSTRAP_TEST": "present"},
            tool = ":" + name + "-" + test + "-program",
        )

# SPDX-FileCopyrightText: © 2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

load("@cellar//bootstrap/stage1:defs.bzl", "compiler")

BINUTILS = "cellar//bootstrap/stage1/binutils"

# A TCC that compiles with `tcc` and archives and links with GNU ar and ld.
# `execution_runtime` is the sysroot `tcc` itself was linked against, and
# `sysroot` is passed with -B to everything it compiles.
def gnu_tcc_toolchain(name, tcc, execution_runtime, sysroot, cflags):
    compiler(
        name = name,
        abi = "x86_64-sysv",
        archive_flags = ["crsD"],
        archive_format = "ar",
        archiver = BINUTILS + ":ar",
        cflags = cflags,
        compiler = tcc,
        execution_runtime = execution_runtime,
        family = "tcc",
        ldflags = ["-static"],
        linker = BINUTILS + ":ld",
        object_format = "elf64-x86-64",
        sysroot = sysroot,
    )

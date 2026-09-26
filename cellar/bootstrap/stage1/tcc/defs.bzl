# SPDX-FileCopyrightText: © 2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

load("@cellar//bootstrap/stage1:defs.bzl", "compiler")

# A TCC that compiles, links and archives (`tcc -ar cr`) by itself. Its
# archiver keeps the first 15 characters of each member name.
# `execution_runtime` is the sysroot `tcc` itself was linked against, and
# `sysroot`, when given, is passed with -B to everything it compiles and links.
def tcc_toolchain(name, tcc, execution_runtime, cflags, sysroot = None, ldflags = ["-nostdlib", "-static"]):
    compiler(
        name = name,
        abi = "x86_64-sysv",
        archive_flags = [
            "-ar",
            "cr",
        ],
        archive_format = "ar",
        archive_member_name_limit = 15,
        archiver = tcc,
        cflags = cflags,
        compiler = tcc,
        execution_runtime = execution_runtime,
        family = "tcc",
        ldflags = ldflags,
        object_format = "elf64-x86-64",
        sysroot = sysroot,
    )

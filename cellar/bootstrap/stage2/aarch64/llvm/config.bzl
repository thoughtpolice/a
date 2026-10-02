# SPDX-FileCopyrightText: 2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

load("@cellar//bootstrap/stage1/llvm:runtimes.bzl", "AARCH64_BUILTINS")
load("@cellar//bootstrap/stage2/aarch64/musl:defs.bzl", "INCLUDE_DIRECTORIES", "LIBC_SOURCES")
load("@cellar//bootstrap/stage2/aarch64/musl:sources.bzl", "CRT_SOURCES")

AARCH64 = struct(
    cpu = "arm64",
    triple = "aarch64-unknown-linux-musl",
    abi = "aarch64-aapcs",
    object_format = "elf64-aarch64",
    musl = "cellar//bootstrap/stage2/aarch64/musl",
    linux = "cellar//bootstrap/stage2/aarch64/linux-headers",
    libc_sources = LIBC_SOURCES,
    crt_sources = CRT_SOURCES,
    include_directories = INCLUDE_DIRECTORIES,
    mimalloc = ":mimalloc-source",
    builtins_sources = AARCH64_BUILTINS,
    builtins_flags = ["-DCOMPILER_RT_AARCH64_FMV_USES_GLOBAL_CONSTRUCTOR=1"],
    outline_atomics = True,
)

# SPDX-FileCopyrightText: 2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

load("@cellar//bootstrap:defs.bzl", "filegroup")
load("@cellar//bootstrap/stage1/binutils:defs.bzl", "FILES", "binutils_stage")

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

# Reuse the pinned, projected archive; regenerate all tables with final tools.
filegroup(
    name = "binutils-2.30",
    srcs = {path: "cellar//bootstrap/stage1/binutils:binutils-2.30[" + path + "]" for path in FILES},
)

binutils_stage(
    action_env = {"CELLAR_BOOTSTRAP_IDENTITY": "1"},
    bfd_test_object = ":iberty-argv.o",
    cflags = [
        "-O2",
        "-Werror",
        "-x",
        "c",
    ],
    crt = CRT,
    crtn = CRTN,
    libc = LIBC,
    libc_declares_basename = False,
    libc_headers = MUSL + ":headers",
    source_alias = SOURCE_ALIAS,
    toolchain = CC,
    tools = {
        "bash": "cellar//bootstrap/stage1/bash:bash",
        "bison": "cellar//bootstrap/stage1/bison-final:bison",
        "cat": "cellar//bootstrap/stage1/coreutils-final:cat",
        "flex": "cellar//bootstrap/stage1/flex-final:flex",
        "gawk": "cellar//bootstrap/stage1/gawk-final:gawk",
        "mkdir": "cellar//bootstrap/stage1/coreutils-final:mkdir",
        "rm": "cellar//bootstrap/stage1/coreutils-final:rm",
        "sed": "cellar//bootstrap/stage1/sed-final:sed-bin",
    },
)

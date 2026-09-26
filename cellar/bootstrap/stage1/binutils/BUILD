# SPDX-FileCopyrightText: 2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

load("@cellar//bootstrap:actions.bzl", "generate")
load("@cellar//bootstrap:defs.bzl", "export_file")
load("@cellar//bootstrap:source.bzl", "download_file", "untar")
load(":config.bzl", "CONFIG")
load(":defs.bzl", "binutils_files", "binutils_stage")
load(":sources.bzl", "SOURCES")

MUSL = "cellar//bootstrap/stage1/musl"

download_file(
    name = "binutils-2.30.tar.xz",
    hash = "6e46b8aeae2f727a36f0bd9505e405768a72218f1796f0d09757d45209871ae6",
    urls = ["https://mirrors.kernel.org/gnu/binutils/binutils-2.30.tar.xz"],
)

generate(
    name = "binutils.tar",
    args = [
        "--file",
        "$(location :binutils-2.30.tar.xz)",
        "--output",
    ],
    tool = "cellar//bootstrap/stage0-posix/mescc-tools-extra:unxz",
)

untar(
    name = "binutils-2.30",
    files = binutils_files(SOURCES),
    input = ":binutils.tar",
    untar = "cellar//bootstrap/stage0-posix/mescc-tools-extra:untar",
)

[export_file(name = path) for path in glob([
    "patches/*.patch",
    "tests/*.c",
    "tests/*.s",
    "tests/*.ld",
    "tests/*.sh",
    "generators/*.c",
])]

# TCC and musl 1.1.24 build the tools, with the first generator tools.
binutils_stage(
    cflags = ["-Werror"],
    config = CONFIG,
    crt = [
        MUSL + ":restored-crt1.o",
        MUSL + ":restored-crti.o",
    ],
    crtn = [MUSL + ":restored-crtn.o"],
    libc = [
        MUSL + ":restored-libc.a",
        "cellar//bootstrap/stage1/tcc-musl:musl2-libtcc1.a",
        MUSL + ":restored-libc.a",
    ],
    libc_headers = MUSL + ":headers",
    sources = SOURCES,
    toolchain = MUSL + ":tcc",
    tools = {
        "bash": "cellar//bootstrap/stage1/bash-bootstrap:bash",
        "bison": "cellar//bootstrap/stage1/bison:bison",
        "cat": "cellar//bootstrap/stage1/coreutils:cat",
        "flex": "cellar//bootstrap/stage1/flex:flex",
        "gawk": "cellar//bootstrap/stage1/gawk:gawk",
        "mkdir": "cellar//bootstrap/stage0-posix/mescc-tools-extra:mkdir",
        "rm": "cellar//bootstrap/stage1/coreutils:rm",
        "sed": "cellar//bootstrap/stage1/sed:sed",
    },
)

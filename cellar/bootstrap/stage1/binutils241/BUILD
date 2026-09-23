# SPDX-FileCopyrightText: 2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

load("@cellar//bootstrap:actions.bzl", "generate")
load("@cellar//bootstrap:defs.bzl", "export_file")
load("@cellar//bootstrap:source.bzl", "download_file", "untar")
load(":defs.bzl", "FILES", "binutils_stage")

GCC = "cellar//bootstrap/stage1/gcc10"

MUSL = "cellar//bootstrap/stage1/musl12"

download_file(
    name = "binutils-2.41.tar.xz",
    hash = "ae9a5789e23459e59606e6714723f2d3ffc31c03174191ef0d015bdf06007450",
    size_bytes = 26765692,
    urls = ["https://mirrors.kernel.org/gnu/binutils/binutils-2.41.tar.xz"],
)

generate(
    name = "binutils.tar",
    args = [
        "--file",
        "$(location :binutils-2.41.tar.xz)",
        "--output",
    ],
    tool = "cellar//bootstrap/stage0-posix/mescc-tools-extra:unxz",
)

untar(
    name = "binutils-2.41",
    chdirenv = "cellar//bootstrap/stage0-posix/cellar-extra:chdirenv",
    files = FILES,
    flags = ["-xf"],
    input = ":binutils.tar",
    untar = "cellar//bootstrap/stage1/pax:untar",
)

[export_file(name = path) for path in glob([
    "patches/*.patch",
    "tests/*.c",
    "tests/*.s",
    "tests/*.ld",
    "tests/*.sh",
    "generators/*.c",
])]

# The final GCC 10.5 and musl 1.2.5 build the tools, with final generators.
binutils_stage(
    action_env = {"CELLAR_BOOTSTRAP_IDENTITY": "1"},
    bfd_test_object = ":iberty-argv.o",
    cflags = [
        "-O2",
        "-Werror",
        "-x",
        "c",
    ],
    crt = [
        MUSL + ":crt1.o",
        MUSL + ":crti.o",
        GCC + ":stage3-crtbeginT.o",
    ],
    crtn = [
        GCC + ":stage3-crtend.o",
        MUSL + ":crtn.o",
    ],
    libc = [
        MUSL + ":libc.a",
        GCC + ":stage3-libgcc.a",
        MUSL + ":libc.a",
    ],
    libc_headers = MUSL + ":headers",
    preprocessor = GCC + ":stage3-gcc-command",
    source_alias = "cellar//bootstrap/stage1/tools:source-alias",
    toolchain = GCC + ":stage3-gcc",
    tools = {
        "bash": "cellar//bootstrap/stage1/bash:bash",
        "bison": "cellar//bootstrap/stage1/bison-final:bison",
        "cat": "cellar//bootstrap/stage1/coreutils-final:cat",
        "cmp": "cellar//bootstrap/stage1/diffutils:cmp-bin",
        "flex": "cellar//bootstrap/stage1/flex-final:flex",
        "gawk": "cellar//bootstrap/stage1/gawk-final:gawk",
        "mkdir": "cellar//bootstrap/stage1/coreutils-final:mkdir",
        "rm": "cellar//bootstrap/stage1/coreutils-final:rm",
        "sed": "cellar//bootstrap/stage1/sed-final:sed-bin",
    },
)

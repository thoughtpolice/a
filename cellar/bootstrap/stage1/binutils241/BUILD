# SPDX-FileCopyrightText: 2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

load("@cellar//bootstrap:defs.bzl", "export_file")
load("@cellar//bootstrap:source.bzl", "download_file", "untar")
load("@cellar//bootstrap/stage1/binutils:defs.bzl", "binutils_files", "binutils_stage")
load(":config.bzl", "CONFIG")
load(":sources.bzl", "SOURCES")

GCC = "cellar//bootstrap/stage1/gcc10"

MUSL = "cellar//bootstrap/stage1/musl12"

download_file(
    name = "binutils-2.41.tar.xz",
    hash = "ae9a5789e23459e59606e6714723f2d3ffc31c03174191ef0d015bdf06007450",
    size_bytes = 26765692,
    urls = ["https://mirrors.kernel.org/gnu/binutils/binutils-2.41.tar.xz"],
)

untar(
    name = "binutils-2.41",
    decompress = "cellar//bootstrap/stage0-posix/mescc-tools-extra:unxz",
    files = binutils_files(SOURCES),
    flags = ["-x"],
    input = ":binutils-2.41.tar.xz",
    # The programs this package builds, without their test suites or
    # translations, and without gold, gprofng or the simulators.
    only = [
        "COPYING",
        "COPYING.LIB",
        "COPYING3",
        "COPYING3.LIB",
        "bfd",
        "binutils",
        "gas",
        "gprof",
        "include",
        "ld",
        "libctf",
        "libiberty",
        "libsframe",
        "opcodes",
        "zlib",
    ],
    skip = [
        "bfd/po",
        "binutils/po",
        "binutils/testsuite",
        "gas/po",
        "gas/testsuite",
        "ld/po",
        "ld/testsuite",
        "opcodes/po",
    ],
    untar = "cellar//bootstrap/stage1/pax:untar",
)

# The source changes, tests and generator that differ from the binutils 2.30
# package's. binutils_stage takes the others from there.
LOCAL_FILES = [
    "generators/zlib-tables.c",
    "patches/gen-no-chdir.patch",
    "patches/gen-opcodes-input.patch",
    "patches/gprof-native.patch",
    "patches/tmpdir.patch",
    "tests/bfd-headers.c",
    "tests/bfd.c",
    "tests/opcodes.c",
]

[export_file(name = path) for path in LOCAL_FILES]

# GCC 10.5 and musl 1.2.5 build the tools, with the final generator tools.
binutils_stage(
    action_env = {"CELLAR_BOOTSTRAP_IDENTITY": "1"},
    cflags = [
        "-O2",
        "-Werror",
        "-x",
        "c",
    ],
    config = CONFIG,
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
    local_files = LOCAL_FILES,
    logical_sources = True,
    preprocessor = GCC + ":stage3-gcc-command",
    sources = SOURCES,
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

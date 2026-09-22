# SPDX-FileCopyrightText: 2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

load("@cellar//bootstrap:actions.bzl", "command_test", "generate")
load("@cellar//bootstrap:defs.bzl", "export_file")
load("@cellar//bootstrap:source.bzl", "download_file", "untar")
load("@cellar//bootstrap/stage1:defs.bzl", "c_binary", "c_library", "compiler")
load(":defs.bzl", "FILES", "binutils_stage")

MUSL = "cellar//bootstrap/stage1/musl"

CRT = [
    MUSL + ":restored-crt1.o",
    MUSL + ":restored-crti.o",
]

CRTN = [MUSL + ":restored-crtn.o"]

LIBC = [
    MUSL + ":restored-libc.a",
    "cellar//bootstrap/stage1/tcc-musl:musl2-libtcc1.a",
    MUSL + ":restored-libc.a",
]

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
    chdirenv = "cellar//bootstrap/stage0-posix/cellar-extra:chdirenv",
    files = FILES,
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

binutils_stage(
    bfd_test_object = ":crcgen.o",
    cflags = ["-Werror"],
    crt = CRT,
    crtn = CRTN,
    libc = LIBC,
    libc_headers = MUSL + ":headers",
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

# The compile, archive and link commands have distinct executable providers.
# This bridge is used by the last musl/TCC pass before GCC becomes available.
compiler(
    name = "tcc-with-binutils",
    abi = "x86_64-sysv",
    archive_flags = ["crsD"],
    archive_format = "ar",
    archiver = ":ar",
    cflags = ["-nostdinc"],
    compiler = "cellar//bootstrap/stage1/tcc-musl:tcc-musl2",
    execution_runtime = MUSL + ":runtime-rebuilt",
    family = "tcc",
    ldflags = ["-static"],
    linker = ":ld",
    object_format = "elf64-x86-64",
    stage = "musl-with-binutils",
    sysroot = MUSL + ":runtime-restored",
    target_compatible_with = [
        "cellar//bootstrap/platforms:linux",
        "cellar//bootstrap/platforms:amd64",
    ],
)

c_library(
    name = "gnu-test.a",
    objects = [":as-fixture.o"],
    output = "native.a",
    toolchain = ":tcc-with-binutils",
)

c_binary(
    name = "gnu-toolchain-test-bin",
    libraries = [":gnu-test.a"] + LIBC,
    objects = CRT + [":as-test.o"] + CRTN,
    output = "gnu-toolchain-test",
    toolchain = ":tcc-with-binutils",
)

command_test(
    name = "gnu-toolchain-link",
    tool = ":gnu-toolchain-test-bin",
)

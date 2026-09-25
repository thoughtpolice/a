# SPDX-FileCopyrightText: © 2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

load("@cellar//bootstrap:actions.bzl", "command_test", "generate")
load("@cellar//bootstrap:defs.bzl", "export_file")
load("@cellar//bootstrap:host.bzl", "host_python_test")
load("@cellar//bootstrap:source.bzl", "download_file", "untar", "write_file")
load("@cellar//bootstrap/stage1:defs.bzl", "compiler")
load(":defs.bzl", "SOURCE", "llvm_files", "llvm_stage", "source_files")

GCC = "cellar//bootstrap/stage1/gcc13"

LIBSTDCXX = "cellar//bootstrap/stage1/libstdcxx13"

BINUTILS = "cellar//bootstrap/stage1/binutils241"

MUSL = "cellar//bootstrap/stage1/musl12"

CHDIRENV = "cellar//bootstrap/stage0-posix/cellar-extra:chdirenv"

download_file(
    name = "llvm-project-23.1.0.src.tar.xz",
    hash = "ab1f0e3ec52448c33e8782eaf0422504b87c7b016b22514653ee0d8fcee479ff",
    size_bytes = 179140728,
    urls = ["https://github.com/llvm/llvm-project/releases/download/llvmorg-23.1.0/llvm-project-23.1.0.src.tar.xz"],
)

generate(
    name = "llvm-project.tar",
    args = [
        "--file",
        "$(location :llvm-project-23.1.0.src.tar.xz)",
        "--output",
    ],
    tool = "cellar//bootstrap/stage0-posix/mescc-tools-extra:unxz",
)

untar(
    name = SOURCE[1:],
    chdirenv = CHDIRENV,
    files = source_files(),
    flags = ["-xf"],
    input = ":llvm-project.tar",
    untar = "cellar//bootstrap/stage1/pax:untar",
)

# The final GCC 13 stage and its C++ library build the first LLVM stage.
REPRODUCIBLE_FLAGS = [
    "-frandom-seed=bootstrap",
    "-g0",
    "-Wno-builtin-macro-redefined",
    '-D__DATE__="Jan  1 1970"',
    '-D__TIME__="00:00:00"',
    '-D__TIMESTAMP__="Thu Jan  1 00:00:00 1970"',
]

compiler(
    name = "gcc13-g++",
    abi = "x86_64-sysv",
    archive_flags = ["crsD"],
    archive_format = "ar",
    archiver = BINUTILS + ":ar",
    cflags = REPRODUCIBLE_FLAGS,
    compiler = LIBSTDCXX + ":stage3-g++",
    execution_runtime = MUSL + ":runtime",
    family = "gcc",
    ldflags = ["-static"],
    linker = BINUTILS + ":ld",
    object_format = "elf64-x86-64",
    stage = "gcc-13.5.0-stage3-c++",
    sysroot = GCC + ":stage3-runtime",
    target_compatible_with = [
        "cellar//bootstrap/platforms:linux",
        "cellar//bootstrap/platforms:amd64",
    ],
)

llvm_files()

# As in an LLVM release build, without assertions, exceptions or RTTI. The
# overlay's triples name glibc; this LLVM runs on and defaults to musl.
llvm_stage(
    defines = {
        name: '{}="x86_64-unknown-linux-musl"'.format(name)
        for name in [
            "LLVM_HOST_TRIPLE",
            "LLVM_DEFAULT_TARGET_TRIPLE",
        ]
    },
    flags = {
        "c": [
            "-std=gnu11",
            "-O2",
            "-DNDEBUG",
        ],
        "c++": [
            "-std=c++17",
            "-O2",
            "-DNDEBUG",
            "-fno-exceptions",
            "-fno-rtti",
        ],
    },
    link = {
        "end_objects": [
            GCC + ":stage3-crtend.o",
            MUSL + ":crtn.o",
        ],
        # musl's default 128 KiB thread stack is too small for LLVM's
        # recursive passes. Its threads take the size from PT_GNU_STACK.
        "flags": [
            "-z",
            "stack-size=8388608",
        ],
        "libraries": [
            LIBSTDCXX + ":stage3-libstdc++.a",
            MUSL + ":libc.a",
            GCC + ":stage3-libgcc.a",
            MUSL + ":libc.a",
        ],
        "objects": [
            MUSL + ":crt1.o",
            MUSL + ":crti.o",
            GCC + ":stage3-crtbeginT.o",
        ],
    },
    stage = "gcc",
    toolchains = {
        "c": GCC + ":stage3-gcc",
        "c++": ":gcc13-g++",
    },
)

export_file(name = "tests/tblgen.sh")

generate(
    name = "gcc-tblgen-result",
    args = [
        "--noprofile",
        "--norc",
        "$(location :tests/tblgen.sh)",
        "$(exe :gcc-llvm-llvm-min-tblgen)",
        "$(exe :gcc-llvm-llvm-tblgen)",
        "$(location {})".format(SOURCE),
        "$(location :gcc-tblgen-llvm-vt_gen-0[GenVT.inc])",
    ],
    chdir = CHDIRENV,
    directory = True,
    env = {
        "PATH": "/nonexistent-bootstrap-path",
        "LC_ALL": "C",
    },
    files = ["passed"],
    tool = "cellar//bootstrap/stage1/bash:bash",
)

write_file(
    name = "passed",
    content = "passed\n",
)

command_test(
    name = "gcc-tblgen",
    args = [
        "$(location :gcc-tblgen-result[passed])",
        "$(location :passed)",
    ],
    tool = "cellar//bootstrap/stage0-posix/cellar-extra:bytecmp",
)

# The committed inventory is what inventory.py makes from this tarball.
export_file(name = "inventory.bzl")

host_python_test(
    name = "inventory-test",
    src = "inventory.py",
    args = [
        "--check",
        "$(location {})".format(SOURCE),
        "$(location :inventory.bzl)",
    ],
)

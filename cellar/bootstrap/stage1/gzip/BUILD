# SPDX-FileCopyrightText: 2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

load("@cellar//bootstrap:actions.bzl", "command_test", "concatenate", "generate")
load("@cellar//bootstrap:defs.bzl", "export_file", "filegroup")
load("@cellar//bootstrap:source.bzl", "download_file", "exact_patch", "ungz", "untar", "write_file")
load("@cellar//bootstrap/stage1:defs.bzl", "c_binary", "c_object")

GCC = "cellar//bootstrap/stage1/gcc47"

MUSL = "cellar//bootstrap/stage1/musl12"

CC = GCC + ":stage3-gcc"

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

SOURCES = [
    "gzip.c",
    "zip.c",
    "deflate.c",
    "trees.c",
    "bits.c",
    "unzip.c",
    "inflate.c",
    "util.c",
    "crypt.c",
    "lzw.c",
    "unlzw.c",
    "unpack.c",
    "unlzh.c",
    "getopt.c",
]

FILES = SOURCES + [
    "gzip.h",
    "lzw.h",
    "tailor.h",
    "revision.h",
    "crypt.h",
    "getopt.h",
    "sample/makecrc.c",
    "COPYING",
]

download_file(
    name = "gzip-1.2.4.tar.gz",
    hash = "1ca41818a23c9c59ef1d5e1d00c0d5eaa2285d931c0fb059637d7c0cc02ad967",
    size_bytes = 220623,
    urls = ["https://mirrors.kernel.org/gnu/gzip/gzip-1.2.4.tar.gz"],
)

ungz(
    name = "gzip.tar",
    input = ":gzip-1.2.4.tar.gz",
    ungz = "cellar//bootstrap/stage0-posix/mescc-tools-extra:ungz",
)

untar(
    name = "gzip-1.2.4",
    chdirenv = "cellar//bootstrap/stage0-posix/cellar-extra:chdirenv",
    files = FILES,
    flags = [
        "--numeric-owner",
        "-xf",
    ],
    input = ":gzip.tar",
    untar = "cellar//bootstrap/stage1/tar:tar",
)

c_object(
    name = "makecrc.o",
    src = ":gzip-1.2.4[sample/makecrc.c]",
    flags = [
        "-O2",
        "-Werror",
    ],
    object_name = "makecrc.o",
    toolchain = CC,
)

c_binary(
    name = "makecrc",
    end_objects = CRTN,
    libraries = LIBC,
    objects = CRT + [":makecrc.o"],
    toolchain = CC,
)

generate(
    name = "crc-values",
    capture = "cellar//bootstrap/stage1/tools:capture",
    tool = ":makecrc",
)

# Discard the release-generated table before composing the consumed source.
generate(
    name = "util-handwritten",
    args = [
        "/^ulg crc_32_tab\\[\\] = {/,$d",
        "$(location :gzip-1.2.4[util.c])",
    ],
    capture = "cellar//bootstrap/stage1/tools:capture",
    tool = "cellar//bootstrap/stage1/sed:sed",
)

write_file(
    name = "crc-prefix",
    content = "ulg crc_32_tab[] = {\n",
)

write_file(
    name = "crc-suffix",
    content = "};\n",
)

concatenate(
    name = "util.c",
    inputs = [
        ":util-handwritten",
        ":crc-prefix",
        ":crc-values",
        ":crc-suffix",
    ],
    tool = "cellar//bootstrap/stage0-posix/mescc-tools-extra:catm",
)

[export_file(name = path) for path in glob(["patches/*"])]

exact_patch(
    name = "getopt.c",
    src = ":gzip-1.2.4[getopt.c]",
    patch = ":patches/prototypes.patch",
)

filegroup(
    name = "source",
    srcs = {path: ":gzip-1.2.4[" + path + "]" for path in FILES} | {
        "util.c": ":util.c",
        "getopt.c": ":getopt.c",
    },
)

# Native POSIX interfaces, generic C compression, file timestamps and recursion.
[c_object(
    name = path + ".o",
    src = ":source[" + path + "]",
    defines = [
        "_GNU_SOURCE=1",
        "STDC_HEADERS=1",
        "HAVE_UNISTD_H=1",
        "DIRENT=1",
    ],
    flags = [
        "-O2",
        "-Werror",
    ],
    logical_includes = ["."],
    logical_source = path,
    object_name = "gz" + str(i) + ".o",
    source_alias = "cellar//bootstrap/stage1/tools:source-alias",
    source_tree = ":source",
    toolchain = CC,
) for i, path in enumerate(SOURCES)]

c_binary(
    name = "gzip",
    end_objects = CRTN,
    libraries = LIBC,
    objects = CRT + [":" + path + ".o" for path in SOURCES],
    output = "gzip",
    toolchain = CC,
)

filegroup(
    name = "installation",
    srcs = {
        "bin/gzip": ":gzip",
        "bin/gunzip": ":gzip",
        "bin/zcat": ":gzip",
        "share/licenses/gzip/COPYING": ":gzip-1.2.4[COPYING]",
    },
)

command_test(
    name = "version",
    args = ["--version"],
    tool = ":gzip",
)

c_object(
    name = "roundtrip.o",
    src = "tests/roundtrip.c",
    defines = ["_GNU_SOURCE=1"],
    flags = [
        "-O2",
        "-Wall",
        "-Wextra",
        "-Werror",
    ],
    object_name = "gztest.o",
    toolchain = CC,
)

c_binary(
    name = "roundtrip-bin",
    end_objects = CRTN,
    libraries = LIBC,
    objects = CRT + [":roundtrip.o"],
    toolchain = CC,
)

generate(
    name = "roundtrip",
    args = ["$(exe :gzip)"],
    chdir = "cellar//bootstrap/stage0-posix/cellar-extra:chdirenv",
    directory = True,
    env = {
        "PATH": "/nonexistent-bootstrap-path",
        "TZ": "UTC0",
    },
    files = ["passed"],
    tool = ":roundtrip-bin",
)

write_file(
    name = "passed",
    content = "passed\n",
)

command_test(
    name = "compression-integrity-and-files",
    args = [
        "$(location :roundtrip[passed])",
        "$(location :passed)",
    ],
    tool = "cellar//bootstrap/stage0-posix/cellar-extra:bytecmp",
)

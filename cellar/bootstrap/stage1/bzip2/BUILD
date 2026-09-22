# SPDX-FileCopyrightText: 2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

load("@cellar//bootstrap:actions.bzl", "command_test", "generate")
load("@cellar//bootstrap:defs.bzl", "filegroup")
load("@cellar//bootstrap:source.bzl", "download_file", "exact_patch", "untar")
load("@cellar//bootstrap/stage1:defs.bzl", "c_binary", "c_library", "c_object")

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

LIB = [
    "blocksort",
    "huffman",
    "compress",
    "decompress",
    "bzlib",
    "randtable",
    "crctable",
]

PROGRAMS = [
    "bzip2",
    "bzip2recover",
]

FILES = [name + ".c" for name in LIB + PROGRAMS if name != "crctable"] + [
    "bzlib.h",
    "bzlib_private.h",
    "LICENSE",
    "README",
] + ["sample" + str(i) + ext for i in [
    1,
    2,
    3,
] for ext in [
    ".ref",
    ".bz2",
]]

download_file(
    name = "bzip2-1.0.8.tar.gz",
    hash = "ab5a03176ee106d3f0fa90e381da478ddae405918153cca248e682cd0c4a2269",
    size_bytes = 810029,
    urls = ["https://sourceware.org/pub/bzip2/bzip2-1.0.8.tar.gz"],
)

generate(
    name = "bzip2.tar",
    args = [
        "-dc",
        "$(location :bzip2-1.0.8.tar.gz)",
    ],
    capture = "cellar//bootstrap/stage1/tools:capture",
    tool = "cellar//bootstrap/stage1/gzip:gzip",
)

untar(
    name = "bzip2-1.0.8",
    chdirenv = "cellar//bootstrap/stage0-posix/cellar-extra:chdirenv",
    files = FILES,
    flags = [
        "--numeric-owner",
        "-xf",
    ],
    input = ":bzip2.tar",
    untar = "cellar//bootstrap/stage1/tar:tar",
)

c_object(
    name = "makecrc.o",
    src = "generators/makecrc.c",
    flags = [
        "-O2",
        "-Wall",
        "-Wextra",
        "-Werror",
    ],
    object_name = "makecrc.o",
    toolchain = CC,
)

c_binary(
    name = "makecrc",
    libraries = LIBC,
    objects = CRT + [":makecrc.o"] + CRTN,
    toolchain = CC,
)

generate(
    name = "crctable.c",
    capture = "cellar//bootstrap/stage1/tools:capture",
    tool = ":makecrc",
)

# musl uses the ISO C length modifier for unsigned long long.
# The modified source retains bzip2's upstream copyright and license.
exact_patch(
    name = "bzip2recover.c",
    src = ":bzip2-1.0.8[bzip2recover.c]",
    after = '#  define MaybeUInt64_FMT "%llu"\n',
    before = '#  define MaybeUInt64_FMT "%Lu"\n',
)

filegroup(
    name = "source",
    srcs = {path: ":bzip2-1.0.8[" + path + "]" for path in FILES} | {
        "crctable.c": ":crctable.c",
        "bzip2recover.c": ":bzip2recover.c",
    },
)

[c_object(
    name = name + ".o",
    src = ":source[" + name + ".c]",
    defines = ["_FILE_OFFSET_BITS=64"],
    flags = [
        "-O2",
        "-Werror",
    ],
    logical_includes = ["."],
    logical_source = name + ".c",
    object_name = "bz" + str(i) + ".o",
    source_alias = "cellar//bootstrap/stage1/tools:source-alias",
    source_tree = ":source",
    toolchain = CC,
) for i, name in enumerate(LIB + PROGRAMS)]

c_library(
    name = "libbz2.a",
    objects = [":" + name + ".o" for name in LIB],
    output = "libbz2.a",
    toolchain = CC,
)

[c_binary(
    name = name,
    libraries = ([":libbz2.a"] if name == "bzip2" else []) + LIBC,
    objects = CRT + [":" + name + ".o"] + CRTN,
    output = name,
    toolchain = CC,
) for name in PROGRAMS]

filegroup(
    name = "installation",
    srcs = {
        "bin/bzip2": ":bzip2",
        "bin/bunzip2": ":bzip2",
        "bin/bzcat": ":bzip2",
        "bin/bzip2recover": ":bzip2recover",
        "include/bzlib.h": ":source[bzlib.h]",
        "lib/libbz2.a": ":libbz2.a",
        "share/licenses/bzip2/LICENSE": ":source[LICENSE]",
    },
)

# Upstream test vectors are test data only, never compiled inputs.
[
    [
        generate(
            name = "compress-" + str(i),
            args = [
                "-" + str(i),
                "-c",
            ],
            capture = "cellar//bootstrap/stage1/tools:capture",
            stdin = ":source[sample" + str(i) + ".ref]",
            tool = ":bzip2",
        ),
        generate(
            name = "decompress-" + str(i),
            args = ["-dc"] + (["-s"] if i == 3 else []),
            capture = "cellar//bootstrap/stage1/tools:capture",
            stdin = ":source[sample" + str(i) + ".bz2]",
            tool = ":bzip2",
        ),
        command_test(
            name = "compressed-vector-" + str(i),
            args = [
                "$(location :compress-" + str(i) + ")",
                "$(location :source[sample" + str(i) + ".bz2])",
            ],
            tool = "cellar//bootstrap/stage0-posix/cellar-extra:bytecmp",
        ),
        command_test(
            name = "decompressed-vector-" + str(i),
            args = [
                "$(location :decompress-" + str(i) + ")",
                "$(location :source[sample" + str(i) + ".ref])",
            ],
            tool = "cellar//bootstrap/stage0-posix/cellar-extra:bytecmp",
        ),
    ]
    for i in [
        1,
        2,
        3,
    ]
]

generate(
    name = "recovered",
    args = [
        "--noprofile",
        "--norc",
        "-ec",
        '\"$1\" \"$2\" > source.bz2; \"$3\" source.bz2; \"$4\" -dc rec00001source.bz2 > restored',
        "recover-test",
        "$(exe cellar//bootstrap/stage1/coreutils:cat)",
        "$(location :source[sample1.bz2])",
        "$(exe :bzip2recover)",
        "$(exe :bzip2)",
    ],
    chdir = "cellar//bootstrap/stage0-posix/cellar-extra:chdirenv",
    directory = True,
    env = {
        "CELLAR_BOOTSTRAP_IDENTITY": "1",
        "PATH": "/nonexistent-bootstrap-path",
    },
    files = ["restored"],
    tool = "cellar//bootstrap/stage1/bash:bash",
)

command_test(
    name = "block-recovery",
    args = [
        "$(location :recovered[restored])",
        "$(location :source[sample1.ref])",
    ],
    tool = "cellar//bootstrap/stage0-posix/cellar-extra:bytecmp",
)

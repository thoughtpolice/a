# SPDX-FileCopyrightText: 2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

load("@cellar//bootstrap:actions.bzl", "command_test")
load("@cellar//bootstrap:source.bzl", "download_file")
load("@cellar//bootstrap/stage1/gcc:defs.bzl", "EXPECT_EXIT", "GCC47", "gcc_port")
load(":config.bzl", "CONFIG")
load(":sources.bzl", "SOURCES")

# makeucnid regenerates ucnid.h from the Unicode 6.3.0 data it was last
# generated from.
[
    download_file(
        name = name + "-6.3.0.txt",
        hash = digest,
        size_bytes = size,
        urls = ["https://www.unicode.org/Public/6.3.0/ucd/" + name + ".txt"],
    )
    for name, digest, size in [
        ("UnicodeData", "3f76924f0410ca8ae0e9b5c59bd1ba03196293c32616204b393300f091f52013", 1367023),
        ("DerivedNormalizationProps", "c5e867ae043fe5d1cf713150d859356bfdcdba291c39f584af0bfb943f1a9743", 783470),
    ]
]

# GCC 10 is written in C++98, so the final GCC 4.7 stage and its C++ library
# build the first stage.
gcc_port(
    archive_hash = "25109543fdf46f397c347b5d8b7a2c7e5694a5a51cce4b9c6e1ea8a71ca307c1",
    archive_size = 77846412,
    binutils = "cellar//bootstrap/stage1/binutils",
    config = CONFIG,
    driver_lookup = "find_a_file (&exec_prefixes, commands[0].prog, X_OK, false)",
    genversion = False,
    host = GCC47,
    host_libstdcxx = "cellar//bootstrap/stage1/libstdcxx",
    libstdcxx = "cellar//bootstrap/stage1/libstdcxx10",
    skip = ["gcc/brig"],
    sources = SOURCES,
    suffix = ".c",
    # The GCC 4.7 port's change applies unchanged.
    tmpdir_patch = GCC47 + ":patches/tmpdir.patch",
    ucnid_inputs = [
        ":UnicodeData-6.3.0.txt",
        ":DerivedNormalizationProps-6.3.0.txt",
    ],
    unicode_version = "12.1.0",
    version = "10.5.0",
)

# Split stacks would use glibc's %fs:0x70 slot, which musl's thread control
# block does not have, so tm.h removes them.
command_test(
    name = "runtime-reject-glibc-split-stack",
    args = [
        "1",
        "$(exe :stage1-cc1)",
        "-quiet",
        "-frandom-seed=bootstrap",
        "-fsplit-stack",
        "$(location :tiny.c)",
        "-o",
        "/dev/null",
    ],
    tool = EXPECT_EXIT,
)

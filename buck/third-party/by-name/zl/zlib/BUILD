# SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

load("@root//buck/shims:shims.bzl", "shims")

GIT_COMMIT = "767c4c947852e143f582c85f14cf573411df1b35"

shims.http_archive(
    name = "src",
    sha256 = "cafa75b907cd067b471fba32a2772c010a859086241ef70d3d57eda6aeea3a64",
    strip_prefix = "zlib-{}".format(GIT_COMMIT),
    sub_targets = [
        "adler32.c",
        "compress.c",
        "crc32.c",
        "deflate.c",
        "infback.c",
        "inffast.c",
        "inflate.c",
        "inftrees.c",
        "trees.c",
        "uncompr.c",
        "zutil.c",
        "gzclose.c",
        "gzlib.c",
        "gzread.c",
        "gzwrite.c",
        "zlib.h",
        "zconf.h",
        "crc32.h",
        "deflate.h",
        "gzguts.h",
        "inffast.h",
        "inffixed.h",
        "inflate.h",
        "inftrees.h",
        "trees.h",
        "zutil.h",
    ],
    type = "tar.gz",
    urls = [
        "https://github.com/madler/zlib/archive/{}.tar.gz".format(GIT_COMMIT),
    ],
)

shims.cxx_library(
    name = "libz",
    srcs = [
        ":src[adler32.c]",
        ":src[compress.c]",
        ":src[crc32.c]",
        ":src[deflate.c]",
        ":src[gzclose.c]",
        ":src[gzlib.c]",
        ":src[gzread.c]",
        ":src[gzwrite.c]",
        ":src[infback.c]",
        ":src[inffast.c]",
        ":src[inflate.c]",
        ":src[inftrees.c]",
        ":src[trees.c]",
        ":src[uncompr.c]",
        ":src[zutil.c]",
    ],
    compiler_flags = [
        "-DSTDC",
        "-D_LARGEFILE64_SOURCE",
        "-D_POSIX_SOURCE",
    ],
    exported_headers = {
        "zconf.h": ":src[zconf.h]",
        "zlib.h": ":src[zlib.h]",
    },
    header_namespace = "",
    headers = {
        "crc32.h": ":src[crc32.h]",
        "deflate.h": ":src[deflate.h]",
        "gzguts.h": ":src[gzguts.h]",
        "inffast.h": ":src[inffast.h]",
        "inffixed.h": ":src[inffixed.h]",
        "inflate.h": ":src[inflate.h]",
        "inftrees.h": ":src[inftrees.h]",
        "trees.h": ":src[trees.h]",
        "zutil.h": ":src[zutil.h]",
    },
    preferred_linkage = "static",
)

# SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

load("@root//buck/shims:package.bzl", "pkg")
load("@root//buck/shims:shims.bzl", "shims")

VERSION = pkg.version()

shims.http_archive(
    name = "src",
    sha256 = "bb329a0a2cd0274d05519d61c667c062e06990d72e125ee2dfa8de64f0119d16",
    strip_prefix = "zlib-{VERSION}".format(VERSION = VERSION),
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
        "https://github.com/madler/zlib/releases/download/v{VERSION}/zlib-{VERSION}.tar.gz".format(VERSION = VERSION),
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

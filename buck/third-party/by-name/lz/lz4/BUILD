# SPDX-FileCopyrightText: © 2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

load("@root//buck/shims:package.bzl", "pkg")
load("@root//buck/shims:shims.bzl", "shims")

VERSION = pkg.version()

shims.http_archive(
    name = "src",
    sha256 = "537512904744b35e232912055ccf8ec66d768639ff3abe5788d90d792ec5f48b",
    strip_prefix = "lz4-{}".format(VERSION),
    sub_targets = [
        "lib/lz4.c",
        "lib/lz4.h",
        "lib/lz4file.c",
        "lib/lz4file.h",
        "lib/lz4frame.c",
        "lib/lz4frame.h",
        "lib/lz4frame_static.h",
        "lib/lz4hc.c",
        "lib/lz4hc.h",
        "lib/xxhash.c",
        "lib/xxhash.h",
    ],
    type = "tar.gz",
    urls = [
        "https://github.com/lz4/lz4/archive/refs/tags/v{}.tar.gz".format(VERSION),
    ],
)

shims.cxx_library(
    name = "lz4",
    srcs = [
        ":src[lib/lz4.c]",
        ":src[lib/lz4file.c]",
        ":src[lib/lz4frame.c]",
        ":src[lib/lz4hc.c]",
        ":src[lib/xxhash.c]",
    ],
    exported_headers = {
        "lz4.h": ":src[lib/lz4.h]",
        "lz4file.h": ":src[lib/lz4file.h]",
        "lz4frame.h": ":src[lib/lz4frame.h]",
        "lz4frame_static.h": ":src[lib/lz4frame_static.h]",
        "lz4hc.h": ":src[lib/lz4hc.h]",
    },
    header_namespace = "",
    headers = {
        "xxhash.h": ":src[lib/xxhash.h]",
    },
    preferred_linkage = "static",
)

shims.cxx_binary(
    name = "test-roundtrip-bin",
    srcs = ["test.c"],
    deps = [":lz4"],
)

shims.command_test(
    name = "test-roundtrip",
    cmd = ["$(exe :test-roundtrip-bin)"],
)

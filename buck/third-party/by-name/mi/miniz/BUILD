# SPDX-FileCopyrightText: © 2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

load("@root//buck/shims:shims.bzl", "shims")

GIT_COMMIT = "6ef6c68f4fcbb8287aa8edf9c6670804932f41c6"

SOURCES = [
    "miniz.c",
    "miniz_tdef.c",
    "miniz_tinfl.c",
    "miniz_zip.c",
]

HEADERS = [
    "miniz.h",
    "miniz_common.h",
    "miniz_tdef.h",
    "miniz_tinfl.h",
    "miniz_zip.h",
]

shims.http_archive(
    name = "src",
    sha256 = "d9ef3c09f98b0dba3aa60e520284ed54042b0baa86116312be3f36e26393ae27",
    strip_prefix = "miniz-{}".format(GIT_COMMIT),
    sub_targets = SOURCES + HEADERS,
    type = "tar.gz",
    urls = [
        "https://github.com/richgel999/miniz/archive/{}.tar.gz".format(GIT_COMMIT),
    ],
)

# The split sources, as miniz's CMakeLists.txt builds them when not
# amalgamating. miniz_export.h, which CMake generates, is written here for a
# static library.
shims.cxx_library(
    name = "miniz",
    srcs = [":src[{}]".format(f) for f in SOURCES],
    exported_headers = {
        f: ":src[{}]".format(f)
        for f in HEADERS
    } | {
        "miniz_export.h": "miniz_export.h",
    },
    header_namespace = "",
    preferred_linkage = "static",
)

shims.cxx_binary(
    name = "test-roundtrip-bin",
    srcs = ["test.c"],
    deps = [":miniz"],
)

shims.command_test(
    name = "test-roundtrip",
    cmd = ["$(exe :test-roundtrip-bin)"],
)

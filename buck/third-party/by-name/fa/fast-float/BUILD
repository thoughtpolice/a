# SPDX-FileCopyrightText: © 2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

load("@root//buck/shims:package.bzl", "pkg")
load("@root//buck/shims:shims.bzl", "shims")

VERSION = pkg.version()

HEADERS = [
    "ascii_number.h",
    "bigint.h",
    "constexpr_feature_detect.h",
    "decimal_to_binary.h",
    "digit_comparison.h",
    "fast_float.h",
    "fast_table.h",
    "float_common.h",
    "parse_number.h",
]

shims.http_archive(
    name = "src",
    sha256 = "3f05bdecaaa2a3ac0e99c3e0a286a6ab2b1cdcc10cf8fb1e67d1b2e12d2365f7",
    strip_prefix = "fast_float-{}".format(VERSION),
    sub_targets = ["include/fast_float/{}".format(h) for h in HEADERS],
    type = "tar.gz",
    urls = [
        "https://github.com/fastfloat/fast_float/archive/refs/tags/v{}.tar.gz".format(VERSION),
    ],
)

shims.cxx_library(
    name = "fast-float",
    exported_headers = {
        "fast_float/{}".format(h): ":src[include/fast_float/{}]".format(h)
        for h in HEADERS
    },
    header_namespace = "",
)

shims.cxx_binary(
    name = "test-parse-bin",
    srcs = ["test.cpp"],
    deps = [":fast-float"],
)

shims.command_test(
    name = "test-parse",
    cmd = ["$(exe :test-parse-bin)"],
)

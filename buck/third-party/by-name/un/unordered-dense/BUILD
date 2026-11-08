# SPDX-FileCopyrightText: © 2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

load("@root//buck/shims:package.bzl", "pkg")
load("@root//buck/shims:shims.bzl", "shims")

VERSION = pkg.version()

shims.http_archive(
    name = "src",
    sha256 = "2364ce4bc4c23bd02549bbb3a7572d881684cd46057f3737fd53be53669743aa",
    strip_prefix = "unordered_dense-{}".format(VERSION),
    sub_targets = ["include/ankerl/unordered_dense.h"],
    type = "tar.gz",
    urls = [
        "https://github.com/martinus/unordered_dense/archive/refs/tags/v{}.tar.gz".format(VERSION),
    ],
)

shims.cxx_library(
    name = "unordered-dense",
    exported_headers = {
        "ankerl/unordered_dense.h": ":src[include/ankerl/unordered_dense.h]",
    },
    header_namespace = "",
)

shims.cxx_binary(
    name = "test-map-bin",
    srcs = ["test.cpp"],
    deps = [":unordered-dense"],
)

shims.command_test(
    name = "test-map",
    cmd = ["$(exe :test-map-bin)"],
)

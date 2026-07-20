# SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

load("@prelude//:paths.bzl", "paths")
load("@root//buck/shims:shims.bzl", depot = "shims")

depot.cxx_library(
    name = "libedsign-headers",
    exported_headers = {
        "edsign.h": "inc/edsign.h",
    },
    header_namespace = "libedsign",
    visibility = [],
)

depot.cxx_library(
    name = "libedsign",
    srcs = glob(["src/*.c"]),
    exported_deps = [":libedsign-headers"],
    raw_headers = glob(["src/*.h"]),
    tests = [":tests"],
    visibility = ["PUBLIC"],
)

TESTS = [paths.basename(t).removesuffix(".c") for t in glob(["t/*.c"])]

[
    depot.cxx_binary(
        name = "test-{}-exe".format(t),
        srcs = ["t/{}.c".format(t)],
        deps = [":libedsign"],
    )
    for t in TESTS
]

[
    depot.command_test(
        name = "test-{}".format(t),
        cmd = ["$(exe :test-{}-exe)".format(t)],
    )
    for t in TESTS
]

depot.test_suite(
    name = "tests",
    tests = [":test-{}".format(t) for t in TESTS],
)

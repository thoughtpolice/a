# SPDX-FileCopyrightText: © 2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

load("@root//buck/shims:shims.bzl", "shims")

# A static, pure Go executable: it needs only the standard library, unlike
# the upstream Hurl binaries it replaces, which needed host libcurl and libxml2.
shims.go_binary(
    name = "barf",
    srcs = glob(
        ["*.go"],
        exclude = ["*_test.go"],
    ),
    tests = [
        "root//buck/tools/barf/tests:custom-arguments",
        "root//buck/tools/barf/tests:default-arguments",
        ":unit",
    ],
    visibility = ["PUBLIC"],
)

shims.go_test(
    name = "unit",
    srcs = glob(["*.go"]),
)

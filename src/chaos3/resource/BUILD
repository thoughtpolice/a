# SPDX-FileCopyrightText: © 2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

load("@root//buck/shims:shims.bzl", depot = "shims")

depot.go_binary(
    name = "resource",
    srcs = ["main.go"],
    tests = [":test"],
    visibility = ["PUBLIC"],
)

depot.go_test(
    name = "test",
    srcs = [
        "main.go",
        "main_test.go",
    ],
    visibility = ["PUBLIC"],
)

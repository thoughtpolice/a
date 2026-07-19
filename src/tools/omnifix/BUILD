# SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

load("@root//buck/shims:shims.bzl", "shims")

SRCS = [
    "buildifier.go",
    "command.go",
    "gofmt.go",
    "main.go",
    "nixfmt.go",
    "omnifix.go",
    "paths.go",
    "rustfmt.go",
    "whitespace.go",
]

shims.go_binary(
    name = "omnifix",
    srcs = SRCS,
    cgo_enabled = False,
    link_mode = "internal",
    tests = [":unit"],
    visibility = ["PUBLIC"],
)

shims.go_test(
    name = "unit",
    srcs = SRCS + [
        "buildifier_test.go",
        "gofmt_test.go",
        "main_test.go",
        "nixfmt_test.go",
        "omnifix_test.go",
        "paths_test.go",
        "rustfmt_test.go",
        "whitespace_test.go",
    ],
    cgo_enabled = False,
)

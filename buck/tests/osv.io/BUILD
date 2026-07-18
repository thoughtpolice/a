# SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

load("@root//buck/shims:shims.bzl", "shims")

SRCS = [
    "cargo.go",
    "generic.go",
    "main.go",
    "model.go",
    "osv.go",
    "report.go",
]

shims.go_binary(
    name = "osv.io",
    srcs = SRCS,
    cgo_enabled = False,
    tests = [
        ":check",
        ":unit",
    ],
)

shims.go_test(
    name = "unit",
    srcs = SRCS + ["main_test.go"],
    cgo_enabled = False,
)

shims.run_test(
    name = "check",
    dep = ":osv.io",
)

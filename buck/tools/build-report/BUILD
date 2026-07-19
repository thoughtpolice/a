# SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

load("@root//buck/shims:shims.bzl", "shims")

SRCS = [
    "analyze.go",
    "console.go",
    "main.go",
    "markdown.go",
    "rawreport.go",
    "report.go",
    "text.go",
]

shims.go_binary(
    name = "build-report",
    srcs = SRCS,
    cgo_enabled = False,
    link_mode = "internal",
    tests = [":unit"],
    visibility = ["PUBLIC"],
)

shims.go_test(
    name = "unit",
    srcs = SRCS + [
        "analyze_test.go",
        "console_test.go",
        "fixtures_test.go",
        "main_test.go",
        "markdown_test.go",
        "rawreport_test.go",
        "text_test.go",
    ],
    cgo_enabled = False,
)

# SPDX-FileCopyrightText: © 2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

load("@root//buck/shims:shims.bzl", "shims")

SRCS = [
    "emit.go",
    "extract.go",
    "framework.go",
    "lock.go",
    "main.go",
    "manifest.go",
    "nupkg.go",
    "resolve.go",
    "source.go",
    "version.go",
]

shims.go_binary(
    name = "nugetify",
    srcs = SRCS,
    cgo_enabled = False,
    link_mode = "internal",
    tests = [":unit"],
    visibility = ["PUBLIC"],
)

shims.go_test(
    name = "unit",
    srcs = SRCS + [
        "emit_test.go",
        "framework_test.go",
        "main_test.go",
        "manifest_test.go",
        "nupkg_test.go",
        "resolve_test.go",
        "source_test.go",
        "version_test.go",
    ],
    cgo_enabled = False,
)

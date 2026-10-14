# SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

load("@root//buck/shims:shims.bzl", "shims")

shims.go_binary(
    name = "check-starlark-load-syntax",
    srcs = ["main.go"],
    cgo_enabled = False,
    link_mode = "internal",
    tests = [
        ":starlark-load-syntax",
        ":unit",
    ],
)

shims.go_test(
    name = "unit",
    srcs = [
        "main.go",
        "main_test.go",
    ],
    cgo_enabled = False,
)

shims.run_test(
    name = "starlark-load-syntax",
    # Mirrors the files starlarkFiles in main.go checks. No dot forms: it
    # skips any dot-leading directory, which is also where these globs stop.
    ci_srcs = [
        "**/BUILD",
        "**/PACKAGE",
        "**/*.bzl",
    ],
    dep = ":check-starlark-load-syntax",
)

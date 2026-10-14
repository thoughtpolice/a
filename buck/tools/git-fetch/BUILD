# SPDX-FileCopyrightText: © 2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

load("@root//buck/shims:shims.bzl", "shims")

shims.go_binary(
    name = "git-fetch",
    srcs = glob(
        ["*.go"],
        exclude = ["*_test.go"],
    ),
    cgo_enabled = False,
    link_mode = "internal",
    # What `-m release` adds for Go, which compiles optimized either way.
    # This runs as an exec dep of every git_fetch, which `-m release`
    # never reaches, and a stripped binary is less to download from the
    # cache.
    linker_flags = [
        "-s",
        "-w",
    ],
    tests = [":unit"],
)

shims.go_test(
    name = "unit",
    srcs = glob(["*.go"]),
    cgo_enabled = False,
)

# SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

load("@root//buck/shims:shims.bzl", "shims")

# Run by every srclint test; see buck/shims/srclint.bzl.
shims.go_binary(
    name = "srclint",
    srcs = glob(
        ["*.go"],
        exclude = ["*_test.go"],
    ),
    tests = [":unit"],
)

shims.go_test(
    name = "unit",
    srcs = glob(["*.go"]),
)

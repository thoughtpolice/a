# SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

load("@root//buck/shims:shims.bzl", "shims")

# Checks one file under buck/bin; //buck/bin:tests runs it on each of them.
shims.go_binary(
    name = "check-dotslash-file",
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

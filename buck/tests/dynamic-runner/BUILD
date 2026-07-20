# SPDX-FileCopyrightText: © 2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

load("@root//buck/shims:shims.bzl", "shims")

shims.go_binary(
    name = "fixture",
    srcs = ["main.go"],
    cgo_enabled = False,
    tests = [":dynamic-runner"],
)

shims.dynamic_test(
    name = "dynamic-runner",
    dep = ":fixture",
)

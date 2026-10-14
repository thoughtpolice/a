# SPDX-FileCopyrightText: © 2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

load("@root//buck/shims:shims.bzl", "shims")

# Two targets over main.go for the language server's smoke test, so that the
# file is in two packages: the binary's and its test's.
shims.go_binary(
    name = "hello",
    srcs = ["main.go"],
    tests = [":hello-test"],
    deps = ["//golang/lsp/tests/greeting"],
)

shims.go_test(
    name = "hello-test",
    srcs = [
        "main.go",
        "main_test.go",
    ],
    deps = ["//golang/lsp/tests/greeting"],
)

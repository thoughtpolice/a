# SPDX-FileCopyrightText: © 2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

load("@root//buck/shims:shims.bzl", "shims")

# A binary using the library's headers and the standard library's, for the
# language server's smoke test.
shims.cxx_binary(
    name = "hello",
    srcs = ["main.cpp"],
    deps = ["//cxx/lsp/tests/greeting"],
)

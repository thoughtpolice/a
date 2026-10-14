# SPDX-FileCopyrightText: © 2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

load("@root//buck/shims:shims.bzl", "shims")

shims.go_library(
    name = "greeting",
    srcs = ["greeting.go"],
    visibility = ["toolchains//golang/lsp/tests/..."],
)

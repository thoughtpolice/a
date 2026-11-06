# SPDX-FileCopyrightText: © 2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

load("@root//buck/shims:shims.bzl", "shims")

# A library and its unit tests, over the same lib.rs, which rust-project
# gives rust-analyzer as one crate with cfg(test) on.
shims.rust_library(
    name = "greeting",
    srcs = ["lib.rs"],
    tests = [":greeting-test"],
    visibility = ["toolchains//rust/lsp/tests/..."],
)

shims.rust_test(
    name = "greeting-test",
    srcs = ["lib.rs"],
)

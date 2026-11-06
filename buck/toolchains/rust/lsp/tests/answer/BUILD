# SPDX-FileCopyrightText: © 2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

load("@root//buck/shims:shims.bzl", "shims")

# A proc macro, which rust-analyzer expands with the dylib Buck builds.
shims.rust_library(
    name = "answer",
    srcs = ["lib.rs"],
    proc_macro = True,
    visibility = ["toolchains//rust/lsp/tests/..."],
)

# SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

load("@root//buck/shims:shims.bzl", depot = "shims")

# #[chez::procedure] and chez::library!, for the chez crate (..), which
# re-exports them.
depot.rust_library(
    name = "chez-macros",
    srcs = ["lib.rs"],
    crate = "chez_macros",
    crate_root = "lib.rs",
    proc_macro = True,
    visibility = ["PUBLIC"],
    deps = [
        "third-party//rust:proc-macro2",
        "third-party//rust:quote",
        "third-party//rust:syn",
    ],
)

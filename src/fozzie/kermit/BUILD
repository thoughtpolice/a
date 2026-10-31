# SPDX-FileCopyrightText: © 2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

load("@root//buck/shims:shims.bzl", depot = "shims")

depot.rust_library(
    name = "kermit",
    srcs = glob(["*.rs"]),
    crate = "kermit",
    crate_root = "lib.rs",
    visibility = ["PUBLIC"],
)

depot.rust_test(
    name = "tests",
    srcs = glob(["*.rs"]),
    crate = "kermit",
    crate_root = "lib.rs",
    deps = [
        "third-party//by-name/mi/mimalloc:rust",
    ],
)

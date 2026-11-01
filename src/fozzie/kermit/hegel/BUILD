# SPDX-FileCopyrightText: © 2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

load("@root//buck/shims:shims.bzl", depot = "shims")

DEPS = [
    "root//src/fozzie/kermit:kermit",
    "third-party//rust:hegeltest",
]

depot.rust_library(
    name = "hegel",
    srcs = ["lib.rs"],
    crate = "kermit_hegel",
    crate_root = "lib.rs",
    visibility = ["PUBLIC"],
    deps = DEPS,
)

depot.rust_test(
    name = "tests",
    srcs = ["lib.rs"],
    crate = "kermit_hegel",
    crate_root = "lib.rs",
    visibility = ["PUBLIC"],
    deps = DEPS + [
        "third-party//by-name/mi/mimalloc:rust",
    ],
)

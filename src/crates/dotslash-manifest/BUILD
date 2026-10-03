# SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

load("@root//buck/shims:shims.bzl", depot = "shims")

DEPS = [
    "third-party//rust:anyhow",
    "third-party//rust:serde",
    "third-party//rust:serde_json",
]

depot.rust_library(
    name = "dotslash-manifest",
    srcs = glob(["*.rs"]),
    crate_root = "lib.rs",
    visibility = ["PUBLIC"],
    deps = DEPS,
)

depot.rust_test(
    name = "tests",
    srcs = glob(["*.rs"]),
    crate_root = "lib.rs",
    deps = DEPS,
)

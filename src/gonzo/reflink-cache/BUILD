# SPDX-FileCopyrightText: © 2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

load("@root//buck/shims:shims.bzl", depot = "shims")

SRCS = glob(
    ["*.rs"],
    exclude = [
        "test_*.rs",
        "tests.rs",
    ],
)

DEPS = [
    "//src/crates/reapi-cas",
    "third-party//rust:anyhow",
    "third-party//rust:libc",
    "third-party//rust:tokio",
]

depot.rust_library(
    name = "reflink-cache",
    srcs = SRCS,
    crate_root = "lib.rs",
    tests = [":tests"],
    visibility = ["PUBLIC"],
    deps = DEPS,
)

depot.rust_test(
    name = "tests",
    srcs = glob(["*.rs"]),
    crate_root = "lib.rs",
    deps = DEPS + [
        "third-party//rust:tempfile",
        "third-party//rust:thiserror",
    ],
)

# SPDX-FileCopyrightText: © 2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

load("@root//buck/shims:shims.bzl", depot = "shims")

DEPS = [
    "//src/crates/runtime-env:runtime-env",
    "third-party//rust:anyhow",
    "third-party//rust:libc",
    "third-party//rust:tempfile",
    "third-party//rust:thiserror",
    "third-party//rust:tokio",
    "third-party//rust:tracing",
]

depot.rust_library(
    name = "hermetic-run",
    srcs = glob(["*.rs"]),
    crate_root = "lib.rs",
    tests = [":tests"],
    visibility = ["PUBLIC"],
    deps = DEPS,
)

depot.rust_test(
    name = "tests",
    srcs = glob(["*.rs"]),
    crate_root = "lib.rs",
    deps = DEPS,
)

# SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

load("@root//buck/shims:shims.bzl", depot = "shims")

DEPS = [
    "//src/crates/loghist:loghist",
    "third-party//rust:serde_json",
    "third-party//rust:tokio",
]

depot.rust_library(
    name = "loadgen",
    srcs = glob(["*.rs"]),
    crate_root = "lib.rs",
    edition = "2024",
    tests = [":tests"],
    visibility = ["PUBLIC"],
    deps = DEPS,
)

depot.rust_test(
    name = "tests",
    srcs = glob(["*.rs"]),
    crate_root = "lib.rs",
    edition = "2024",
    deps = DEPS,
)

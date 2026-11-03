# SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

load("@root//buck/shims:shims.bzl", depot = "shims")

depot.rust_library(
    name = "loghist",
    srcs = ["lib.rs"],
    crate_root = "lib.rs",
    edition = "2024",
    tests = [":tests"],
    visibility = ["PUBLIC"],
)

depot.rust_test(
    name = "tests",
    srcs = ["lib.rs"],
    crate_root = "lib.rs",
    edition = "2024",
)

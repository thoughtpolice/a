# SPDX-FileCopyrightText: © 2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

load("@root//buck/shims:shims.bzl", depot = "shims")

DEPS = [
    "third-party//rust:iroh",
    "third-party//rust:tokio",
]

depot.rust_library(
    name = "iroh-utils",
    srcs = glob(["*.rs"]),
    crate_root = "lib.rs",
    tests = [":iroh-utils-unittest"],
    visibility = ["PUBLIC"],
    deps = DEPS,
)

depot.rust_test(
    name = "iroh-utils-unittest",
    srcs = glob(["*.rs"]),
    crate_root = "lib.rs",
    deps = DEPS + [
        "root//src/crates/iroh-boring:iroh-boring",
    ],
)

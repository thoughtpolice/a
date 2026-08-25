# SPDX-FileCopyrightText: © 2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

load("@root//buck/shims:shims.bzl", depot = "shims")

DEPS = [
    "root//src/crates/rustls-boring:rustls-boring",
    "third-party//rust:iroh",
    "third-party//rust:rustls",
]

depot.rust_library(
    name = "iroh-boring",
    srcs = glob(["*.rs"]),
    crate_root = "lib.rs",
    tests = [":iroh-boring-unittest"],
    visibility = ["PUBLIC"],
    deps = DEPS,
)

depot.rust_test(
    name = "iroh-boring-unittest",
    srcs = glob(["*.rs"]),
    crate_root = "lib.rs",
    deps = DEPS + [
        "root//src/crates/iroh-utils:iroh-utils",
        "third-party//rust:tokio",
    ],
)

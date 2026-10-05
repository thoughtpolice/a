# SPDX-FileCopyrightText: © 2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

load("@root//buck/shims:shims.bzl", depot = "shims")

DEPS = [
    "third-party//rust:futures",
    "third-party//rust:iroh",
    "third-party//rust:iroh-mainline-address-lookup",
    "third-party//rust:iroh-mdns-address-lookup",
    "third-party//rust:iroh-tickets",
    "third-party//rust:n0-mainline",
    "third-party//rust:tokio",
]

depot.rust_library(
    name = "iroh-dial",
    srcs = glob(["*.rs"]),
    crate_root = "lib.rs",
    tests = [":iroh-dial-unittest"],
    visibility = ["PUBLIC"],
    deps = DEPS,
)

depot.rust_test(
    name = "iroh-dial-unittest",
    srcs = glob(["*.rs"]),
    crate_root = "lib.rs",
    deps = DEPS + [
        "root//src/crates/iroh-boring:iroh-boring",
        "root//src/crates/iroh-utils:iroh-utils",
    ],
)

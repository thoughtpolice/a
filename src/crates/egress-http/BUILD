# SPDX-FileCopyrightText: © 2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

load("@root//buck/shims:shims.bzl", depot = "shims")

DEPS = [
    "root//src/crates/egress:egress",
    "third-party//rust:bytes",
    "third-party//rust:http-body-util",
    "third-party//rust:hyper",
    "third-party//rust:hyper-util",
    "third-party//rust:openssl",
    "third-party//rust:thiserror",
    "third-party//rust:tokio",
    "third-party//rust:tokio-openssl",
]

depot.rust_library(
    name = "egress-http",
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

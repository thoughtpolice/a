# SPDX-FileCopyrightText: © 2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

load("@root//buck/shims:shims.bzl", depot = "shims")

DEPS = [
    "third-party//rust:hyper",
    "third-party//rust:tokio",
    "third-party//rust:tonic",
    "third-party//rust:tower",
    "third-party//rust:tracing",
]

depot.rust_library(
    name = "grpc-guards",
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

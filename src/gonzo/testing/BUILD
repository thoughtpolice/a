# SPDX-FileCopyrightText: © 2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

load("@root//buck/shims:shims.bzl", depot = "shims")

# For tests only: a daemon in process, for the scheduler's, the worker's and
# the server's tests to talk to.
depot.rust_library(
    name = "gonzo-testing",
    srcs = ["lib.rs"],
    crate_root = "lib.rs",
    visibility = ["//src/gonzo/..."],
    deps = [
        "third-party//rust:bytes",
        "third-party//rust:dial9",
        "third-party//rust:hex",
        "third-party//rust:prost",
        "third-party//rust:tokio",
        "third-party//rust:tonic",
        "//src/crates/dial9-tonic",
        "//src/crates/reapi-protos:protos",
        "//src/gonzo/api",
        "//src/gonzo/storage",
    ],
)

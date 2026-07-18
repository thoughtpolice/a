# SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

load("@root//buck/shims:shims.bzl", depot = "shims")

depot.rust_library(
    name = "common",
    srcs = ["lib.rs"],
    visibility = ["PUBLIC"],
    deps = [
        "third-party//rust:anyhow",
        "third-party//rust:clap",
        "third-party//rust:tokio",
        "third-party//rust:tonic",
        "third-party//rust:tracing",
        "third-party//rust:tracing-subscriber",
        "//buck/installers/proto",
    ],
)

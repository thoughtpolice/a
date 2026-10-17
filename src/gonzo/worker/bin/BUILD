# SPDX-FileCopyrightText: © 2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

load("@root//buck/shims:shims.bzl", depot = "shims")

DEPS = [
    "third-party//by-name/mi/mimalloc:rust",
    "third-party//rust:anyhow",
    "third-party//rust:clap",
    "third-party//rust:tokio",
    "third-party//rust:tracing",
    "third-party//rust:tracing-subscriber",
    "//src/crates/iroh-dial",
    "//src/crates/reapi-protos:protos",
    "//src/gonzo/mesh",
    "//src/gonzo/runtime",
    "//src/gonzo/worker",
]

depot.rust_binary(
    name = "gonzo-worker",
    srcs = ["main.rs"],
    crate_root = "main.rs",
    visibility = ["PUBLIC"],
    deps = DEPS,
)

depot.rust_test(
    name = "tests",
    srcs = ["main.rs"],
    crate_root = "main.rs",
    deps = DEPS,
)

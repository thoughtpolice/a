# SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

load("@root//buck/shims:shims.bzl", depot = "shims")

DEPS = [
    "third-party//by-name/mi/mimalloc:rust",
    "//src/crates/reapi-protos:protos",
    "third-party//rust:anyhow",
    "third-party//rust:bytes",
    "third-party//rust:clap",
    "third-party//rust:futures",
    "third-party//rust:hex",
    "third-party//rust:prost",
    "third-party//rust:serde_json",
    "third-party//rust:sha2",
    "third-party//rust:tokio",
    "third-party//rust:tonic",
    "third-party//rust:zstd",
]

# Load generator and correctness checker for the cache server; see main.rs.
depot.rust_binary(
    name = "cache-bench",
    srcs = glob(["*.rs"]),
    crate_root = "main.rs",
    edition = "2024",
    visibility = ["PUBLIC"],
    deps = DEPS,
)

depot.rust_test(
    name = "tests",
    srcs = glob(["*.rs"]),
    crate_root = "main.rs",
    edition = "2024",
    deps = DEPS,
)

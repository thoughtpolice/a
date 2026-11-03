# SPDX-FileCopyrightText: © 2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

load("@root//buck/shims:shims.bzl", depot = "shims")

DEPS = [
    "//src/crates/hermetic-run:hermetic-run",
    "//src/crates/reapi-cas",
    "//src/crates/reapi-client",
    "//src/crates/reapi-protos:protos",
    "//src/crates/reflink-cache",
    "third-party//rust:anyhow",
    "third-party//rust:bytes",
    "third-party//rust:prost",
    "third-party//rust:quick_cache",
    "third-party//rust:tokio",
    "third-party//rust:tonic",
]

depot.rust_library(
    name = "reapi-exec",
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
    deps = DEPS + [
        "third-party//rust:futures",
        "third-party//rust:libc",
        "third-party//rust:tempfile",
    ],
)

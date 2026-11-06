# SPDX-FileCopyrightText: © 2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

load("@root//buck/shims:shims.bzl", depot = "shims")

DEPS = [
    "//src/crates/hermetic-run:hermetic-run",
    "//src/crates/reapi-cas",
    "//src/gonzo/reapi-exec",
    "//src/gonzo/reflink-cache",
    "//src/crates/reapi-protos:protos",
    "//src/gonzo/protos:gonzo-protos",
    "third-party//rust:anyhow",
    "third-party//rust:libc",
    "third-party//rust:prost",
    "third-party//rust:prost-types",
    "third-party//rust:tempfile",
    "third-party//rust:tokio",
    "third-party//rust:tokio-stream",
    "third-party//rust:tonic",
    "third-party//rust:tracing",
]

depot.rust_library(
    name = "worker",
    srcs = glob(["*.rs"]),
    crate_root = "lib.rs",
    tests = [":tests"],
    visibility = ["//src/gonzo/..."],
    deps = DEPS,
)

depot.rust_test(
    name = "tests",
    srcs = glob(["*.rs"]),
    crate_root = "lib.rs",
    deps = DEPS + [
        "//src/gonzo/scheduler",
        "//src/gonzo/testing:gonzo-testing",
    ],
)

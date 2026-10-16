# SPDX-FileCopyrightText: © 2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

load("@root//buck/shims:shims.bzl", depot = "shims")

DEPS = [
    "//src/crates/reapi-protos:protos",
    "//src/gonzo/api:api",
    "//src/gonzo/protos:gonzo-protos",
    "//src/gonzo/storage:storage",
    "third-party//rust:futures",
    "third-party//rust:prost",
    "third-party//rust:prost-types",
    "third-party//rust:tokio",
    "third-party//rust:tokio-stream",
    "third-party//rust:tonic",
    "third-party//rust:tracing",
    "third-party//rust:uuid",
]

depot.rust_library(
    name = "scheduler",
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
        "third-party//rust:bytes",
        "third-party//rust:dial9",
        "third-party//rust:hex",
        "third-party//rust:sha2",
        "//src/crates/dial9-tonic",
    ],
)

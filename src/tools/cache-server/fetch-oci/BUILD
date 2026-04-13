# SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

load("@root//buck/shims:shims.bzl", depot = "shims")

DEPS = [
    "//src/tools/cache-server/fetch-http:fetch-http",
    "//src/tools/cache-server/protos:protos",
    "third-party//rust:bytes",
    "third-party//rust:dial9",
    "third-party//rust:futures",
    "third-party//rust:hex",
    "third-party//rust:http-body-util",
    "third-party//rust:hyper",
    "third-party//rust:hyper-util",
    "third-party//rust:openssl",
    "third-party//rust:serde",
    "third-party//rust:serde_json",
    "third-party//rust:sha2",
    "third-party//rust:tokio",
    "third-party//rust:tokio-openssl",
    "third-party//rust:tonic",
    "third-party//rust:tracing",
]

depot.rust_library(
    name = "fetch-oci",
    srcs = glob(["*.rs"]),
    visibility = ["//src/tools/cache-server/..."],
    deps = DEPS,
)

depot.rust_test(
    name = "tests",
    srcs = glob(["*.rs"]),
    deps = DEPS,
)

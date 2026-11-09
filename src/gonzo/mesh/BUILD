# SPDX-FileCopyrightText: © 2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

load("@root//buck/shims:shims.bzl", depot = "shims")

DEPS = [
    "third-party//rust:hyper-util",
    "third-party//rust:iroh",
    "third-party//rust:tokio",
    "third-party//rust:tonic",
    "third-party//rust:tower",
    "//src/crates/iroh-mesh",
]

depot.rust_library(
    name = "mesh",
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
        "third-party//rust:dial9",
        "third-party//rust:tonic-health",
        "//src/crates/dial9-tonic",
        "//src/crates/iroh-dial",
        "//src/crates/iroh-utils",
    ],
)

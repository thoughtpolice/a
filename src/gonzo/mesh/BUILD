# SPDX-FileCopyrightText: © 2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

load("@root//buck/shims:shims.bzl", depot = "shims")

DEPS = [
    "third-party//rust:blake3",
    "third-party//rust:hex",
    "third-party//rust:hyper-util",
    "third-party//rust:iroh",
    "third-party//rust:iroh-tickets",
    "third-party//rust:thiserror",
    "third-party//rust:tokio",
    "third-party//rust:tonic",
    "third-party//rust:tower",
    "third-party//rust:tracing",
    "//src/crates/accept",
    "//src/crates/iroh-boring",
    "//src/crates/iroh-dial",
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
        "third-party//rust:tempfile",
        "third-party//rust:tonic-health",
        "//src/crates/dial9-tonic",
        "//src/crates/iroh-utils",
    ],
)

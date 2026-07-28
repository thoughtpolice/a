# SPDX-FileCopyrightText: © 2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

load("@root//buck/shims:shims.bzl", depot = "shims")

DEPS = [
    # in-tree deps
    "//src/crates/reapi-protos:protos",
    # crates.io
    "third-party//rust:base64",
    "third-party//rust:blake3",
    "third-party//rust:bytes",
    "third-party//rust:futures",
    "third-party//rust:hex",
    "third-party//rust:sha2",
    "third-party//rust:thiserror",
    "third-party//rust:tokio",
    "third-party//rust:tonic",
    "third-party//rust:uuid",
]

depot.rust_library(
    name = "reapi-client",
    srcs = glob(["*.rs"]),
    crate_root = "lib.rs",
    visibility = ["PUBLIC"],
    deps = DEPS,
)

depot.rust_test(
    name = "tests",
    srcs = glob(["*.rs"]),
    crate_root = "lib.rs",
    deps = DEPS,
)

# Round-trips against a real cache-server process, which the test spawns from
# the binary handed to it as a resource. Split from `:tests` so that the pure
# unit tests stay buildable everywhere: cache-server is Linux-only.
depot.rust_test(
    name = "integration-tests",
    srcs = glob(["*.rs"]),
    crate_root = "lib.rs",
    resources = {
        "cache-server": "//src/tools/cache-server:cache-server",
    },
    rustc_flags = ["--cfg=integration_tests"],
    target_compatible_with = ["config//os:linux"],
    deps = DEPS + ["third-party//rust:buck-resources"],
)

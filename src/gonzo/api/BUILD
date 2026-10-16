# SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

load("@root//buck/shims:shims.bzl", depot = "shims")

DEPS = [
    "//src/crates/reapi-protos:protos",
    "//src/gonzo/assets/git:git",
    "//src/gonzo/assets/http:http",
    "//src/gonzo/assets/oci:oci",
    "//src/gonzo/storage:storage",
    "//src/gonzo/telemetry:telemetry",
    "third-party//rust:bytes",
    "third-party//rust:dial9",
    "third-party//rust:futures",
    "third-party//rust:hex",
    "third-party//rust:openssl",
    "third-party//rust:prost",
    "third-party//rust:prost-types",
    "third-party//rust:tokio",
    "third-party//rust:tokio-stream",
    "third-party//rust:tonic",
    "third-party//rust:tonic-prost",
    "third-party//rust:tower",
    "third-party//rust:tracing",
]

depot.rust_library(
    name = "api",
    srcs = glob(["*.rs"]),
    visibility = ["//src/gonzo/..."],
    deps = DEPS,
)

TEST_MODULES = {
    "cas": {},
    "split_splice": {},
    "action_cache": {},
    "bytestream": {},
    "resource_names": {},
    "remote_asset": {},
}

TEST_DEPS = DEPS + [
    "third-party//rust:base64",
    "third-party//rust:jiff",
    "third-party//rust:serde_json",
    "third-party//rust:sha2",
]

# Per-module test targets
[depot.rust_test(
    name = "tests-" + name,
    srcs = glob(["*.rs"]),
    crate_root = "lib.rs",
    rustc_flags = ["--cfg=test_module_" + name],
    deps = TEST_DEPS,
) for name in TEST_MODULES]

# All-in-one target
depot.rust_test(
    name = "tests",
    srcs = glob(["*.rs"]),
    crate_root = "lib.rs",
    rustc_flags = ["--cfg=test_module_" + name for name in TEST_MODULES],
    deps = TEST_DEPS,
)

# SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

load("@root//buck/shims:shims.bzl", depot = "shims")

BUILD_DEPS = [
    # 3p deps
    "third-party//by-name/mi/mimalloc:rust",
    # local deps
    "//src/crates/accept:accept",
    "//src/crates/dial9-tonic:dial9-tonic",
    "//src/crates/iroh-dial:iroh-dial",
    "//src/crates/reapi-protos:protos",
    "//src/crates/rustls-boring:rustls-boring",
    "//src/crates/rustls-transport:rustls-transport",
    "//src/gonzo/api:api",
    "//src/gonzo/assets/oci:oci",
    "//src/gonzo/mesh:mesh",
    "//src/gonzo/protos:gonzo-protos",
    "//src/gonzo/runtime:runtime",
    "//src/gonzo/scheduler:scheduler",
    "//src/gonzo/storage:storage",
    "//src/gonzo/telemetry:telemetry",
    "//src/gonzo/worker:worker",
    # crates.io
    "third-party//rust:jiff",
    "third-party//rust:anyhow",
    "third-party//rust:clap",
    "third-party//rust:dial9",
    "third-party//rust:console-subscriber",
    "third-party//rust:rustls",
    "third-party//rust:serde",
    "third-party//rust:serde_json",
    "third-party//rust:tokio",
    "third-party//rust:tonic",
    "third-party//rust:tower",
    "third-party//rust:hyper",
    "third-party//rust:hyper-util",
    "third-party//rust:tonic-health",
    "third-party//rust:tonic-reflection",
    "third-party//rust:tracing",
    "third-party//rust:tracing-subscriber",
]

depot.rust_binary(
    name = "gonzo",
    srcs = glob(["server/*.rs"]),
    visibility = ["PUBLIC"],
    deps = BUILD_DEPS,
)

TEST_MODULES = {
    "dial9": {},
    "request_timeout": {},
    "serve": {},
    "tls": {
        "resources": {
            "cert.pem": "//src/crates/rustls-transport:test-cert",
            "key.pem": "//src/crates/rustls-transport:test-key",
        },
    },
}

ALL_TEST_RESOURCES = {
    "cert.pem": "//src/crates/rustls-transport:test-cert",
    "key.pem": "//src/crates/rustls-transport:test-key",
}

TEST_DEPS = BUILD_DEPS + [
    "//src/crates/iroh-utils:iroh-utils",
    "//src/gonzo/testing:gonzo-testing",
    "third-party//rust:buck-resources",
    "third-party//rust:bytes",
    "third-party//rust:futures",
    "third-party//rust:hex",
    "third-party//rust:prost",
    "third-party//rust:sha2",
    "third-party//rust:tempfile",
    "third-party//rust:tonic-prost",
]

# Per-module test targets
[depot.rust_test(
    name = "tests-" + name,
    srcs = glob(["server/*.rs"]),
    crate_root = "server/main.rs",
    resources = config.get("resources", {}),
    rustc_flags = ["--cfg=test_module_" + name],
    deps = TEST_DEPS,
) for name, config in TEST_MODULES.items()]

# All-in-one target
depot.rust_test(
    name = "tests",
    srcs = glob(["server/*.rs"]),
    crate_root = "server/main.rs",
    resources = ALL_TEST_RESOURCES,
    rustc_flags = ["--cfg=test_module_" + name for name in TEST_MODULES],
    deps = TEST_DEPS,
)

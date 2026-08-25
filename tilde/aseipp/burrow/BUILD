# SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

load("@root//buck/shims:shims.bzl", depot = "shims")

CORE_DEPS = [
    "root//src/crates/iroh-utils:iroh-utils",
    "third-party//rust:anyhow",
    "third-party//rust:base64",
    "third-party//rust:futures",
    "third-party//rust:iroh",
    "third-party//rust:serde",
    "third-party//rust:serde_json",
    "third-party//rust:tokio",
    "third-party//rust:tracing",
]

DEPS = [
    ":burrow-core",
    "third-party//by-name/mi/mimalloc:rust",
    "root//src/crates/iroh-boring:iroh-boring",
    "root//src/crates/iroh-utils:iroh-utils",
    "third-party//rust:anyhow",
    "third-party//rust:clap",
    "third-party//rust:futures",
    "third-party//rust:hex",
    "third-party//rust:iroh",
    "third-party//rust:tempfile",
    "third-party//rust:tokio",
    "third-party//rust:tracing",
    "third-party//rust:tracing-subscriber",
]

depot.rust_library(
    name = "burrow-core",
    srcs = glob(["core/*.rs"]),
    crate_root = "core/lib.rs",
    tests = [":burrow-core-unittest"],
    visibility = ["PUBLIC"],
    deps = CORE_DEPS,
)

depot.rust_test(
    name = "burrow-core-unittest",
    srcs = glob([
        "core/*.rs",
        "tests/core/*.rs",
    ]),
    crate_root = "core/lib.rs",
    deps = CORE_DEPS + [
        "root//src/crates/iroh-boring:iroh-boring",
    ],
)

depot.rust_binary(
    name = "burrow",
    srcs = glob(["*.rs"]),
    tests = [":burrow-unittest"],
    deps = DEPS,
)

depot.rust_test(
    name = "burrow-unittest",
    srcs = glob([
        "*.rs",
        "tests/*.rs",
    ]),
    crate_root = "main.rs",
    deps = DEPS,
)

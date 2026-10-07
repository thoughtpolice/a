# SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

load("@root//buck/shims:shims.bzl", depot = "shims")

DEPS = [
    "third-party//by-name/mi/mimalloc:rust",
    "third-party//rust:anyhow",
    "third-party//rust:clap",
    "third-party//rust:serde",
    "third-party//rust:serde_json",
    "third-party//rust:rsvelte",
    "third-party//rust:rsvelte_core",
    "third-party//rust:rsvelte_formatter",
    "third-party//rust:rsvelte_lint",
    "third-party//rust:oxc",
    "third-party//rust:oxc_formatter",
    "third-party//rust:oxc_linter",
    "third-party//rust:oxc_sourcemap",
]

depot.rust_binary(
    name = "web",
    srcs = glob(["*.rs"]),
    crate_root = "main.rs",
    edition = "2024",
    visibility = ["PUBLIC"],
    deps = DEPS,
)

depot.rust_test(
    name = "tests",
    srcs = glob(["*.rs"]),
    crate_root = "main.rs",
    edition = "2024",
    deps = DEPS,
)

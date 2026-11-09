# SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

load("@root//buck/shims:shims.bzl", depot = "shims")

COMMON_DEPS = [
    "//buck/installers/common:common",
    "third-party//rust:anyhow",
    "third-party//rust:clap",
    "third-party//rust:tokio",
    "third-party//rust:tracing",
]

# Installs files under a prefix directory, ~/.local by default:
#
#   buck2 install //my:target -- --prefix DIR
depot.rust_binary(
    name = "prefix",
    srcs = ["main.rs"],
    tests = [":prefix-tests"],
    deps = COMMON_DEPS,
)

depot.rust_test(
    name = "prefix-tests",
    srcs = ["main.rs"],
    deps = COMMON_DEPS + [
        "third-party//rust:tempfile",
    ],
)

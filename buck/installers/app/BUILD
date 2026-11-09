# SPDX-FileCopyrightText: © 2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

load("@root//buck/shims:shims.bzl", depot = "shims")

COMMON_DEPS = [
    "//buck/installers/common:common",
    "third-party//rust:anyhow",
    "third-party//rust:clap",
    "third-party//rust:tokio",
    "third-party//rust:tracing",
]

# Installs macOS apps (NAME.app bundles, as macos_app in defs.bzl makes
# them) in ~/Applications, each replaced whole:
#
#   buck2 install //my:tool.app -- --dir DIR
depot.rust_binary(
    name = "app",
    srcs = ["main.rs"],
    tests = [":app-tests"],
    deps = COMMON_DEPS,
)

depot.rust_test(
    name = "app-tests",
    srcs = ["main.rs"],
    deps = COMMON_DEPS + [
        "third-party//rust:tempfile",
    ],
)

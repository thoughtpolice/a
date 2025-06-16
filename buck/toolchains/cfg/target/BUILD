# SPDX-FileCopyrightText: © 2024-2025 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

load("@root//buck/shims/shims.bzl", depot = "shims")

[
    depot.config_setting(
        name = name,
        constraint_values = [ 'toolchains//cfg/target/constraint:' + name ],
    ) for name in [
        "x86_64-unknown-uefi",
        "x86_64-unknown-linux-gnu",
        "aarch64-unknown-uefi",
        "aarch64-unknown-linux-gnu",
        "aarch64-apple-darwin",
    ]
]

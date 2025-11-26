# SPDX-FileCopyrightText: © 2024-2025 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

load("@root//buck/shims:shims.bzl", "shims")
load(":defs.bzl", "get_default_target_triple")

shims.constraint(
    name = "target",
    values = [
        "x86_64-unknown-uefi",
        "x86_64-unknown-linux-gnu",
        "aarch64-unknown-uefi",
        "aarch64-unknown-linux-gnu",
        "aarch64-apple-darwin",
    ],
    default = get_default_target_triple(),
)

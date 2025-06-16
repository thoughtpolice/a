# SPDX-FileCopyrightText: © 2024-2025 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

load("@root//buck/shims/shims.bzl", "shims")

shims.rust_binary(
    name="egglog",
    srcs=["main.rs"],
    deps=[
        "third-party//mimalloc:rust",
        "third-party//rust:clap",
        "third-party//rust:egglog",
        "third-party//rust:env_logger",
        "third-party//rust:log",
    ],
    visibility=["PUBLIC"],
)

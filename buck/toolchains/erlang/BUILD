# SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

load("@prelude//toolchains:erlang.bzl", "system_erlang_toolchain")
load("@root//buck/shims:shims.bzl", "shims")

system_erlang_toolchain(
    name = "erlang",
    visibility = ["PUBLIC"],
)

shims.lint_package()

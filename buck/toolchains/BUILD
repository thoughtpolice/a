# SPDX-FileCopyrightText: © 2024-2025 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

load("@prelude//tests:test_toolchain.bzl", "noop_test_toolchain")
load(
    "@prelude//toolchains:remote_test_execution.bzl", "remote_test_execution_toolchain"
)

toolchain_alias(
    name="genrule",
    actual="toolchains//genrule:genrule",
)

toolchain_alias(
    name="python_bootstrap",
    actual="toolchains//python-bootstrap:python_bootstrap",
)

toolchain_alias(
    name="rust",
    actual="toolchains//rust:rust",
)

toolchain_alias(
    name="cxx",
    actual="toolchains//cxx:cxx",
)

toolchain_alias(
    name="deno",
    actual="toolchains//deno:deno",
)

toolchain_alias(
    name="ocaml",
    actual="toolchains//ocaml:ocaml",
)

remote_test_execution_toolchain(
    name="remote_test_execution",
    visibility=["PUBLIC"],
)

noop_test_toolchain(
    name="test",
    visibility=["PUBLIC"],
)

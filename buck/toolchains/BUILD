# SPDX-FileCopyrightText: © 2024-2025 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

load("@root//buck/shims:shims.bzl", "shims")
load("@prelude//tests:test_toolchain.bzl", "noop_test_toolchain")
load(
    "@prelude//toolchains:remote_test_execution.bzl", "remote_test_execution_toolchain"
)
load("@depot//buck/lib/tar:toolchain.bzl", "tar_toolchain")

shims.toolchain_alias(
    name="genrule",
    actual="toolchains//genrule:genrule",
)

shims.toolchain_alias(
    name="python_bootstrap",
    actual="toolchains//python-bootstrap:python_bootstrap",
)

shims.toolchain_alias(
    name="rust",
    actual="toolchains//rust:rust",
)

shims.toolchain_alias(
    name="cxx",
    actual="toolchains//cxx:cxx",
)

shims.toolchain_alias(
    name="deno",
    actual="toolchains//deno:deno",
)

shims.toolchain_alias(
    name="ocaml",
    actual="toolchains//ocaml:ocaml",
)

shims.toolchain_alias(
    name="golang",
    actual="toolchains//golang:golang",
)

shims.toolchain_alias(
    name="erlang",
    actual="toolchains//erlang:erlang",
)

shims.toolchain_alias(
    name="erlang-default",
    actual="toolchains//erlang:erlang",
)

shims.toolchain_alias(
    name="oci",
    actual="toolchains//oci:oci",
)

tar_toolchain(
    name="tar",
    visibility=["PUBLIC"],
)

remote_test_execution_toolchain(
    name="remote_test_execution",
    visibility=["PUBLIC"],
)

noop_test_toolchain(
    name="test",
    visibility=["PUBLIC"],
)

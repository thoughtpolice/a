# SPDX-FileCopyrightText: © 2024-2025 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

load("@root//buck/shims/shims.bzl", depot = "shims")
load("@prelude//tests:test_toolchain.bzl", "noop_test_toolchain")
load(
    "@prelude//toolchains:remote_test_execution.bzl", "remote_test_execution_toolchain"
)
load("@depot//buck/lib/tar:toolchain.bzl", "tar_toolchain")

depot.toolchain_alias(
    name="genrule",
    actual="toolchains//genrule:genrule",
)

depot.toolchain_alias(
    name="python_bootstrap",
    actual="toolchains//python-bootstrap:python_bootstrap",
)

depot.toolchain_alias(
    name="rust",
    actual="toolchains//rust:rust",
)

depot.toolchain_alias(
    name="cxx",
    actual="toolchains//cxx:cxx",
)

depot.toolchain_alias(
    name="deno",
    actual="toolchains//deno:deno",
)

depot.toolchain_alias(
    name="ocaml",
    actual="toolchains//ocaml:ocaml",
)

depot.toolchain_alias(
    name="golang",
    actual="toolchains//golang:golang",
)

depot.toolchain_alias(
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

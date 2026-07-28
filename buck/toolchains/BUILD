# SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

load("@prelude//tests:test_toolchain.bzl", "noop_test_toolchain")
load(
    "@prelude//toolchains:remote_test_execution.bzl",
    "remote_test_execution_toolchain",
)
load("@root//buck/shims:shims.bzl", "shims")

shims.toolchain_alias(
    name = "genrule",
    actual = "toolchains//genrule:genrule",
)

shims.toolchain_alias(
    name = "python",
    actual = "toolchains//python:python",
)

shims.toolchain_alias(
    name = "python_bootstrap",
    actual = "toolchains//python-bootstrap:python_bootstrap",
)

shims.toolchain_alias(
    name = "rust",
    actual = "toolchains//rust:rust",
)

shims.toolchain_alias(
    name = "cxx",
    actual = "toolchains//cxx:cxx",
)

# The prelude's _cxx_toolchain() attribute default is a select() whose
# non-DEFAULT branch names toolchains//:cxx_no_default_deps. That branch is
# never selectable here, but unconfigured queries (uquery deps/rdeps) walk
# every select branch, so the target has to exist for those to work.
shims.toolchain_alias(
    name = "cxx_no_default_deps",
    actual = "toolchains//cxx:cxx",
)

shims.toolchain_alias(
    name = "deno",
    actual = "toolchains//deno:deno",
)

shims.toolchain_alias(
    name = "k6",
    actual = "toolchains//k6:k6",
)

shims.toolchain_alias(
    name = "ocaml",
    actual = "toolchains//ocaml:ocaml",
)

shims.toolchain_alias(
    name = "go",
    actual = "toolchains//golang:go",
)

shims.toolchain_alias(
    name = "go_bootstrap",
    actual = "toolchains//golang:go_bootstrap",
)

shims.toolchain_alias(
    name = "oci",
    actual = "toolchains//oci:oci",
    target_compatible_with = [
        "config//os:linux",
    ],
)

shims.toolchain_alias(
    name = "erlang",
    actual = "toolchains//erlang:erlang",
)

shims.toolchain_alias(
    name = "erlang-default",
    actual = "toolchains//erlang:erlang",
)

shims.toolchain_alias(
    name = "zuo",
    actual = "toolchains//zuo:zuo",
)

shims.toolchain_alias(
    name = "tar",
    actual = "toolchains//tar:tar",
)

remote_test_execution_toolchain(
    name = "remote_test_execution",
    visibility = ["PUBLIC"],
)

noop_test_toolchain(
    name = "test",
    visibility = ["PUBLIC"],
)

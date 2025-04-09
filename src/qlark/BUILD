# SPDX-FileCopyrightText: © 2024-2025 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

load("@root//buck/shims/shims.bzl", depot="shims")

COMMON_DEPS = [
    "third-party//mimalloc:rust",
    # rust dependencies
    "third-party//rust:anyhow",
    "third-party//rust:clap",
    "third-party//rust:starlark",
    "third-party//rust:starlark_derive",
    "third-party//rust:thiserror",
]

ALL_TESTS = [
    ":qlark-tests",
]

depot.command(
    name="qlark",
    cmd=[
        "$(location :qlark-bin)",
        "--tofu-binary",
        "$(location //buck/bin/extra:tofu)",
    ],
    visibility=["PUBLIC"],
    tests=ALL_TESTS,
)

depot.rust_binary(
    name="qlark-bin",
    srcs=glob(["**/*.rs"]),
    deps=COMMON_DEPS,
    tests=ALL_TESTS,
    visibility=[],
)

depot.rust_test(
    name="qlark-tests",
    srcs=glob(["**/*.rs"]),
    deps=COMMON_DEPS
    + [
        "third-party//rust:insta",
    ],
    env={
        "CARGO_MANIFEST_DIR": ".",
        "INSTA_WORKSPACE_ROOT": ".",
    },
    visibility=[],
)

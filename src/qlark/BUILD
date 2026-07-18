# SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

load("@root//buck/shims:shims.bzl", depot = "shims")

COMMON_DEPS = [
    "third-party//by-name/mi/mimalloc:rust",
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
    name = "qlark",
    cmd = [
        "$(location :qlark-bin)",
        "--tofu-binary",
        "$(location //buck/bin/extra:tofu)",
    ],
    tests = ALL_TESTS,
    visibility = ["PUBLIC"],
)

depot.rust_binary(
    name = "qlark-bin",
    srcs = glob(["**/*.rs"]),
    tests = ALL_TESTS,
    visibility = [],
    deps = COMMON_DEPS,
)

depot.rust_test(
    name = "qlark-tests",
    srcs = glob(["**/*.rs"]),
    env = {
        "CARGO_MANIFEST_DIR": ".",
        "INSTA_WORKSPACE_ROOT": ".",
    },
    visibility = [],
    deps = COMMON_DEPS + [
        "third-party//rust:insta",
    ],
)

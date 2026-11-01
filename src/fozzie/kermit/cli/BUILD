# SPDX-FileCopyrightText: © 2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

load("@root//buck/shims:shims.bzl", depot = "shims")

DEPS = [
    "root//src/fozzie/kermit:kermit",
    "third-party//by-name/mi/mimalloc:rust",
    "third-party//rust:anyhow",
    "third-party//rust:blake3",
    "third-party//rust:clap",
    "third-party//rust:serde_json",
    "third-party//rust:sha1",
    "third-party//rust:sha2",
]

SRCS = glob(
    ["*.rs"],
    exclude = ["cli_test.rs"],
)

depot.rust_binary(
    name = "kermit",
    srcs = SRCS,
    crate_root = "main.rs",
    edition = "2024",
    visibility = ["PUBLIC"],
    deps = DEPS,
)

depot.rust_test(
    name = "unit-tests",
    srcs = SRCS,
    crate = "kermit_cli",
    crate_root = "main.rs",
    edition = "2024",
    deps = DEPS,
)

depot.rust_test(
    name = "cli-tests",
    srcs = ["cli_test.rs"],
    crate_root = "cli_test.rs",
    edition = "2024",
    run_env = {
        "KERMIT": "$(location :kermit)",
    },
    deps = [
        "root//src/fozzie/kermit:kermit",
        "third-party//by-name/mi/mimalloc:rust",
        "third-party//rust:blake3",
        "third-party//rust:serde_json",
        "third-party//rust:tempfile",
    ],
)

depot.test_suite(
    name = "tests",
    tests = [
        ":cli-tests",
        ":unit-tests",
    ],
    visibility = ["PUBLIC"],
)

# SPDX-FileCopyrightText: © 2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

load("@root//buck/shims:shims.bzl", depot = "shims")

SRCS = glob(
    ["*.rs"],
    exclude = [
        "test_*.rs",
        "tests.rs",
    ],
)

DEPS = [
    "//src/crates/reapi-cas",
    "third-party//rust:anyhow",
    "third-party//rust:futures",
    "third-party//rust:libc",
    "third-party//rust:tokio",
]

# Fault injection is compiled out of the library; `reflink-cache-faults`
# is the same crate with it on, for tests and fuzzers here and in its
# users.
depot.rust_library(
    name = "reflink-cache",
    srcs = SRCS,
    crate_root = "lib.rs",
    tests = [":tests"],
    visibility = ["PUBLIC"],
    deps = DEPS + ["//src/crates/faultline:disabled"],
)

depot.rust_library(
    name = "reflink-cache-faults",
    srcs = SRCS,
    crate = "reflink_cache",
    crate_root = "lib.rs",
    visibility = ["PUBLIC"],
    deps = DEPS + ["//src/crates/faultline"],
)

depot.rust_test(
    name = "tests",
    srcs = glob(["*.rs"]),
    crate_root = "lib.rs",
    deps = DEPS + [
        "third-party//rust:hegeltest",
        "third-party//rust:tempfile",
        "third-party//rust:thiserror",
        "//src/crates/faultline",
    ],
)

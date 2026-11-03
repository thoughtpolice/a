# SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

load("@root//buck/shims:shims.bzl", depot = "shims")

DEPS = [
    "//src/crates/expiring-cache:expiring-cache",
    "//src/crates/object-store-local:object-store-local",
    "//src/crates/object-store-s3:object-store-s3",
    "//src/crates/write-admission:write-admission",
    "third-party//rust:async-trait",
    "third-party//rust:bytes",
    "third-party//rust:quick_cache",
    "third-party//rust:slatedb",
    "third-party//rust:slatedb-common",
    "third-party//rust:thiserror",
    "third-party//rust:tokio",
    "third-party//rust:tracing",
]

depot.rust_library(
    name = "slatedb-utils",
    srcs = glob(["*.rs"]),
    crate_root = "lib.rs",
    tests = [":tests"],
    visibility = ["PUBLIC"],
    deps = DEPS,
)

depot.rust_test(
    name = "tests",
    srcs = glob(["*.rs"]),
    crate_root = "lib.rs",
    deps = DEPS + [
        "third-party//rust:tempfile",
    ],
)

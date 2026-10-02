# SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

load("@root//buck/shims:shims.bzl", depot = "shims")

DEPS = [
    "third-party//rust:async-trait",
    "third-party//rust:bytes",
    "third-party//rust:crossbeam-channel",
    "third-party//rust:futures",
    "third-party//rust:object_store",
    "third-party//rust:tokio",
]

depot.rust_library(
    name = "local-object-store",
    srcs = glob(["*.rs"]),
    crate_root = "lib.rs",
    visibility = ["//src/tools/cache-server/..."],
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

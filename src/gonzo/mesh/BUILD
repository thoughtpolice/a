# SPDX-FileCopyrightText: © 2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

load("@root//buck/shims:shims.bzl", depot = "shims")

DEPS = [
    "third-party//rust:blake3",
    "third-party//rust:hex",
    "third-party//rust:iroh",
    "third-party//rust:iroh-tickets",
    "third-party//rust:thiserror",
    "third-party//rust:tokio",
]

depot.rust_library(
    name = "mesh",
    srcs = glob(["*.rs"]),
    crate_root = "lib.rs",
    tests = [":tests"],
    visibility = ["//src/gonzo/..."],
    deps = DEPS,
)

depot.rust_test(
    name = "tests",
    srcs = glob(["*.rs"]),
    crate_root = "lib.rs",
    deps = DEPS + [
        "third-party//rust:tempfile",
        "//src/crates/iroh-boring",
        "//src/crates/iroh-utils",
    ],
)

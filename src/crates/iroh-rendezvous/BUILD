# SPDX-FileCopyrightText: © 2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

load("@root//buck/shims:shims.bzl", depot = "shims")

DEPS = [
    "third-party//rust:blake3",
    "third-party//rust:futures",
    "third-party//rust:hex",
    "third-party//rust:iroh",
    "third-party//rust:n0-mainline",
    "third-party//rust:tokio",
    "third-party//rust:tracing",
]

depot.rust_library(
    name = "iroh-rendezvous",
    srcs = glob(["*.rs"]),
    crate_root = "lib.rs",
    tests = [":iroh-rendezvous-unittest"],
    visibility = ["PUBLIC"],
    deps = DEPS,
)

depot.rust_test(
    name = "iroh-rendezvous-unittest",
    srcs = glob(["*.rs"]),
    crate_root = "lib.rs",
    deps = DEPS,
)

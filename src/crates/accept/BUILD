# SPDX-FileCopyrightText: © 2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

load("@root//buck/shims:shims.bzl", depot="shims")

DEPS = [
    'third-party//rust:tokio',
    'third-party//rust:tracing',
]

depot.rust_library(
    name = 'accept',
    srcs = glob(['*.rs']),
    crate_root = 'lib.rs',
    deps = DEPS,
    visibility = ['PUBLIC'],
)

depot.rust_test(
    name = 'tests',
    srcs = glob(['*.rs']),
    crate_root = 'lib.rs',
    deps = DEPS,
)

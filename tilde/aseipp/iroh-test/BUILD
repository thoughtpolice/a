# SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

load("@root//buck/shims:shims.bzl", depot = "shims")

DEPS = [
    'third-party//by-name/mi/mimalloc:rust',
    'root//src/rustls-boring:rustls-boring',
    'third-party//rust:anyhow',
    'third-party//rust:iroh',
    'third-party//rust:rustls',
    'third-party//rust:tokio',
]

depot.rust_binary(
    name = 'iroh-test',
    srcs = glob(['*.rs']),
    deps = DEPS,
)

depot.rust_test(
    name = 'test',
    srcs = glob(['*.rs']),
    crate_root = 'main.rs',
    deps = DEPS,
)

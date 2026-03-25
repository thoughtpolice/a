# SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

load("@root//buck/shims:shims.bzl", depot = "shims")

DEPS = [
    # 3p deps
    'third-party//by-name/mi/mimalloc:rust',
    # crates.io
    'third-party//rust:anyhow',
    'third-party//rust:blake3',
    'third-party//rust:clap',
    'third-party//rust:hex',
    'third-party//rust:serde',
    'third-party//rust:serde_json',
    'third-party//rust:sha2',
    'third-party//rust:tokio',
    'third-party//rust:tracing',
    'third-party//rust:tracing-subscriber',
]

depot.rust_binary(
    name = 'shabang2',
    srcs = glob(['src/**/*.rs']),
    deps = DEPS,
    visibility = ['PUBLIC'],
)

depot.rust_test(
    name = 'tests',
    srcs = glob(['src/**/*.rs']),
    deps = DEPS + [
        'third-party//rust:tempfile',
    ],
)

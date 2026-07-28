# SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

load("@root//buck/shims:shims.bzl", depot = "shims")

DEPS = [
    # in-tree deps
    'root//src/crates/dotslash-manifest:dotslash-manifest',
    'root//src/crates/reapi-client:reapi-client',
    'root//src/crates/rustls-boring:rustls-boring',
    # 3p deps
    'third-party//by-name/mi/mimalloc:rust',
    # crates.io
    'third-party//rust:anyhow',
    'third-party//rust:blake3',
    'third-party//rust:bytes',
    'third-party//rust:clap',
    'third-party//rust:flate2',
    'third-party//rust:hex',
    'third-party//rust:http',
    'third-party//rust:http-body-util',
    'third-party//rust:hyper',
    'third-party//rust:hyper-rustls',
    'third-party//rust:hyper-util',
    'third-party//rust:serde',
    'third-party//rust:serde_json',
    'third-party//rust:sha2',
    'third-party//rust:tar',
    'third-party//rust:tempfile',
    'third-party//rust:tokio',
    'third-party//rust:tracing',
    'third-party//rust:tracing-subscriber',
    'third-party//rust:zip',
    'third-party//rust:zstd',
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
    deps = DEPS,
)

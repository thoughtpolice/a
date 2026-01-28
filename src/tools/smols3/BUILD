# SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

load("@root//buck/shims:shims.bzl", depot="shims")

BUILD_DEPS = [
    # 3p deps
    'third-party//mimalloc:rust',
    # local deps
    '//src/tools/smols3/store:store',
    # crates.io
    'third-party//rust:anyhow',
    'third-party//rust:clap',
    'third-party//rust:hyper-util',
    'third-party//rust:s3s',
    'third-party//rust:tokio',
    'third-party//rust:tracing',
    'third-party//rust:tracing-subscriber',
]

depot.rust_binary(
    name = 'smols3',
    srcs = ['bin/main.rs'],
    deps = BUILD_DEPS,
    visibility = [ 'PUBLIC' ],
)

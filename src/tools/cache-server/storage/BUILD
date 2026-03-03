# SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

load("@root//buck/shims:shims.bzl", depot="shims")

DEPS = [
    'third-party//rust:anyhow',
    'third-party//rust:async-stream',
    'third-party//rust:blake3',
    'third-party//rust:brotli',
    'third-party//rust:bytes',
    'third-party//rust:fastcdc',
    'third-party//rust:futures',
    'third-party//rust:flate2',
    'third-party//rust:hex',
    'third-party//rust:sha2',
    'third-party//rust:slatedb',
    'third-party//rust:thiserror',
    'third-party//rust:tokio',
    'third-party//rust:tracing',
    'third-party//rust:zstd',
]

depot.rust_library(
    name = 'storage',
    srcs = glob(['*.rs']),
    deps = DEPS,
    visibility = ['//src/tools/cache-server/...'],
)

depot.rust_test(
    name = 'tests',
    srcs = glob(['*.rs']),
    crate_root = 'lib.rs',
    deps = DEPS + [
        'third-party//rust:buck-resources',
    ],
)

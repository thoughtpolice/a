# SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

load("@root//buck/shims:shims.bzl", depot="shims")

DEPS = [
    'third-party//rust:anyhow',
    'third-party//rust:async-trait',
    'third-party//rust:bytes',
    'third-party//rust:cedar-policy',
    'third-party//rust:fjall',
    'third-party//rust:futures',
    'third-party//rust:md5',
    'third-party//rust:s3s',
    'third-party//rust:serde',
    'third-party//rust:serde_json',
    'third-party//rust:thiserror',
    'third-party//rust:tracing',
    'third-party//rust:uuid',
]

depot.rust_library(
    name = 'store',
    srcs = glob(['*.rs']),
    deps = DEPS,
    visibility = ['//src/tools/smols3/...'],
)

depot.rust_test(
    name = 'tests',
    srcs = glob(['*.rs']),
    deps = DEPS + [
        'third-party//rust:tokio',
    ],
)

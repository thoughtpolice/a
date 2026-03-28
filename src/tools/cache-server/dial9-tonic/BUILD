# SPDX-FileCopyrightText: © 2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

load("@root//buck/shims:shims.bzl", depot="shims")

DEPS = [
    'third-party//rust:bytes',
    'third-party//rust:dial9-tokio-telemetry',
    'third-party//rust:futures',
    'third-party//rust:hyper',
    'third-party//rust:hyper-util',
    'third-party//rust:tokio',
    'third-party//rust:tower',
    'third-party//rust:tracing',
]

depot.rust_library(
    name = 'dial9-tonic',
    srcs = glob(['*.rs']),
    deps = DEPS,
    visibility = ['//src/tools/cache-server/...'],
)

depot.rust_test(
    name = 'tests',
    srcs = glob(['*.rs']),
    deps = DEPS,
)

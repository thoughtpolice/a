# SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

load("@root//buck/shims:shims.bzl", depot="shims")

DEPS = [
    'third-party//rust:anyhow',
    'third-party//rust:opentelemetry',
    'third-party//rust:opentelemetry_sdk',
    'third-party//rust:opentelemetry-otlp',
    'third-party//rust:opentelemetry-semantic-conventions',
    'third-party//rust:parking_lot',
    'third-party//rust:tokio',
    'third-party//rust:tracing',
    'third-party//rust:tracing-opentelemetry',
    'third-party//rust:tracing-subscriber',
]

depot.rust_library(
    name = 'telemetry',
    srcs = glob(['*.rs']),
    deps = DEPS,
    visibility = ['//src/tools/cache-server/...'],
)

depot.rust_test(
    name = 'tests',
    srcs = glob(['*.rs']),
    deps = DEPS,
)

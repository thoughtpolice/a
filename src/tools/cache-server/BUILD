# SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

load("@root//buck/shims:shims.bzl", depot="shims")

BUILD_DEPS = [
    # 3p deps
    'third-party//mimalloc:rust',
    # local deps
    ':protos',
    ':storage',
    ':telemetry',
    # crates.io
    'third-party//rust:bytes',
    'third-party//rust:futures',
    'third-party//rust:hex',
    'third-party//rust:sha2',
    'third-party//rust:anyhow',
    'third-party//rust:clap',
    'third-party//rust:console-subscriber',
    'third-party//rust:prost',
    'third-party//rust:prost-types',
    'third-party//rust:tokio',
    'third-party//rust:tokio-stream',
    'third-party//rust:tonic',
    'third-party//rust:tonic-prost',
    'third-party//rust:tonic-health',
    'third-party//rust:tonic-reflection',
    'third-party//rust:tracing',
    'third-party//rust:tracing-subscriber',
]

depot.rust_binary(
    name = 'cache-server',
    srcs = glob(['src/**/*.rs']),
    deps = BUILD_DEPS,
    visibility = [ 'PUBLIC' ],
)

# Protos library is now in protos/BUILD
depot.alias(
    name = 'protos',
    actual = '//src/tools/cache-server/protos:protos',
    visibility = [],
)

# Storage library is in storage/BUILD
depot.alias(
    name = 'storage',
    actual = '//src/tools/cache-server/storage:storage',
    visibility = [],
)

# Telemetry library is in telemetry/BUILD
depot.alias(
    name = 'telemetry',
    actual = '//src/tools/cache-server/telemetry:telemetry',
    visibility = [],
)

# SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

load("@root//buck/shims:shims.bzl", depot="shims")

# Shared deps for REAPI client code (no TUI)
REAPI_CLIENT_DEPS = [
    'third-party//by-name/mi/mimalloc:rust',

    # proto library (shared with cache-server)
    '//src/tools/cache-server/protos:protos',

    # grpc / networking
    'third-party//rust:tonic',
    'third-party//rust:tonic-prost',
    'third-party//rust:prost',
    'third-party//rust:prost-types',
    'third-party//rust:tokio',
    'third-party//rust:tokio-stream',

    # cli
    'third-party//rust:clap',

    # utilities
    'third-party//rust:anyhow',
    'third-party//rust:bytes',
    'third-party//rust:sha2',
    'third-party//rust:hex',
    'third-party//rust:futures',
    'third-party//rust:uuid',
]

depot.rust_binary(
    name = 'client',
    srcs = glob(['**/*.rs'], exclude = ['buck_log_*.rs']),
    crate_root = 'main.rs',
    deps = REAPI_CLIENT_DEPS + [
        # tui
        'third-party//rust:ratatui',
        'third-party//rust:crossterm',
    ],
    visibility = ['PUBLIC'],
)

depot.rust_binary(
    name = 'buck-log-uploader',
    srcs = ['buck_log_uploader.rs', 'client.rs'],
    crate_root = 'buck_log_uploader.rs',
    deps = REAPI_CLIENT_DEPS,
    visibility = ['PUBLIC'],
)

depot.rust_binary(
    name = 'buck-log-downloader',
    srcs = ['buck_log_downloader.rs', 'client.rs'],
    crate_root = 'buck_log_downloader.rs',
    deps = REAPI_CLIENT_DEPS,
    visibility = ['PUBLIC'],
)

# SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

load("@root//buck/shims:shims.bzl", depot = "shims")

# Origin fetching, shared verbatim between the launcher and the publisher.
HTTP_DEPS = [
    'root//src/crates/rustls-boring:rustls-boring',
    'third-party//rust:anyhow',
    'third-party//rust:bytes',
    'third-party//rust:http',
    'third-party//rust:http-body-util',
    'third-party//rust:hyper',
    'third-party//rust:hyper-rustls',
    'third-party//rust:hyper-util',
    'third-party//rust:tracing',
]

COMMON_DEPS = HTTP_DEPS + [
    'root//src/crates/dotslash-manifest:dotslash-manifest',
    'root//src/crates/reapi-client:reapi-client',
    'third-party//by-name/mi/mimalloc:rust',
    'third-party//rust:clap',
    'third-party//rust:tokio',
    'third-party//rust:tracing-subscriber',
]

# The launcher additionally extracts archives and manages the on-disk cache.
DEPS = COMMON_DEPS + [
    'third-party//rust:blake3',
    'third-party//rust:flate2',
    'third-party//rust:hex',
    'third-party//rust:serde',
    'third-party//rust:serde_json',
    'third-party//rust:sha2',
    'third-party//rust:tar',
    'third-party//rust:tempfile',
    'third-party//rust:zip',
    'third-party//rust:zstd',
]

# The publisher only ever handles raw artifact bytes, so it needs none of the
# archive or extraction machinery.
SYNC_DEPS = COMMON_DEPS + [
    'third-party//rust:futures',
]

SYNC_SRCS = [
    'src/sync_main.rs',
    'src/http.rs',
]

depot.rust_binary(
    name = 'shabang2',
    srcs = glob(['src/**/*.rs'], exclude = ['src/sync_main.rs']),
    crate_root = 'src/main.rs',
    deps = DEPS,
    visibility = ['PUBLIC'],
)

depot.rust_binary(
    name = 'shabang2-sync',
    srcs = SYNC_SRCS,
    crate_root = 'src/sync_main.rs',
    deps = SYNC_DEPS,
    visibility = ['PUBLIC'],
)

depot.rust_test(
    name = 'tests',
    srcs = glob(['src/**/*.rs'], exclude = ['src/sync_main.rs']),
    crate_root = 'src/main.rs',
    deps = DEPS,
)

depot.rust_test(
    name = 'sync-tests',
    srcs = SYNC_SRCS,
    crate_root = 'src/sync_main.rs',
    deps = SYNC_DEPS + ['third-party//rust:tempfile'],
)

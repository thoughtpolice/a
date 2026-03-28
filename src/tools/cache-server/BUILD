# SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

load("@root//buck/shims:shims.bzl", depot="shims")

BUILD_DEPS = [
    # 3p deps
    'third-party//mimalloc:rust',
    # local deps
    '//src/tools/cache-server/dial9-tonic:dial9-tonic',
    '//src/tools/cache-server/protos:protos',
    '//src/tools/cache-server/storage:storage',
    '//src/tools/cache-server/telemetry:telemetry',
    # crates.io
    'third-party//rust:bytes',
    'third-party//rust:futures',
    'third-party//rust:hex',
    'third-party//rust:jiff',
    'third-party//rust:sha2',
    'third-party//rust:anyhow',
    'third-party//rust:clap',
    'third-party//rust:dial9-tokio-telemetry',
    'third-party//rust:console-subscriber',
    'third-party//rust:prost',
    'third-party//rust:prost-types',
    'third-party//rust:tokio',
    'third-party//rust:tokio-stream',
    'third-party//rust:tonic',
    'third-party//rust:tower',
    'third-party//rust:hyper',
    'third-party//rust:hyper-util',
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

TEST_MODULES = {
    'cas': {},
    'split_splice': {},
    'action_cache': {},
    'bytestream': {},
    'resource_names': {},
    'remote_asset': {},
}

# Per-module test targets
[depot.rust_test(
    name = 'tests-' + name,
    srcs = glob(['src/**/*.rs']),
    crate_root = 'src/main.rs',
    deps = BUILD_DEPS,
    rustc_flags = ['--cfg=test_module_' + name],
) for name, _ in TEST_MODULES.items()]

# All-in-one target
depot.rust_test(
    name = 'tests',
    srcs = glob(['src/**/*.rs']),
    crate_root = 'src/main.rs',
    deps = BUILD_DEPS,
    rustc_flags = ['--cfg=test_module_' + name for name in TEST_MODULES],
)

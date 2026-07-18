# SPDX-FileCopyrightText: © 2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

load("@root//buck/shims:shims.bzl", depot="shims")

DEPS = [
    'root//src/crates/accept:accept',
    'third-party//rust:futures',
    'third-party//rust:openssl',
    'third-party//rust:rustls',
    'third-party//rust:tokio',
    'third-party//rust:tokio-rustls',
    'third-party//rust:tracing',
]

depot.rust_library(
    name = 'rustls-transport',
    srcs = glob(['*.rs']),
    crate_root = 'lib.rs',
    deps = DEPS,
    visibility = ['PUBLIC'],
)

# A long-lived self-signed pair (CN marked NOT FOR PRODUCTION, expires
# 2126) for any test in the repository that needs TLS material.
depot.export_file(
    name = 'test-cert',
    src = 'testdata/cert.pem',
    visibility = ['PUBLIC'],
)

depot.export_file(
    name = 'test-key',
    src = 'testdata/key.pem',
    visibility = ['PUBLIC'],
)

depot.rust_test(
    name = 'tests',
    srcs = glob(['*.rs']),
    crate_root = 'lib.rs',
    deps = DEPS + [
        'root//src/crates/rustls-boring:rustls-boring',
        'third-party//rust:buck-resources',
    ],
    resources = {
        'cert.pem': ':test-cert',
        'key.pem': ':test-key',
    },
)

# SPDX-FileCopyrightText: © 2024-2025 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

load("@root//buck/shims/shims.bzl", depot = "shims")

depot.rust_binary(
    name = 'qq-cli',
    crate = 'qq',
    srcs = glob(['**/*.rs']),
    deps = [
        '//src/qq/qq-capnp:qq-capnp',
        'third-party//mimalloc:rust',

        # rust dependencies
        'third-party//rust:anyhow',
        'third-party//rust:capnp',
        'third-party//rust:capnp-rpc',
        'third-party//rust:clap',
        'third-party//rust:futures',
        'third-party//rust:jj-lib',
        'third-party//rust:jj-cli',
        'third-party//rust:openssl',
        'third-party//rust:thiserror',
        'third-party//rust:tokio',
        'third-party//rust:tokio-openssl',
        'third-party//rust:tokio-util',
    ],
    visibility = [ 'PUBLIC' ],
)

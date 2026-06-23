# SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

load("@root//buck/shims:shims.bzl", depot = "shims")

depot.rust_binary(
    name = 'qq',
    srcs = glob(['**/*.rs']),
    deps = [
        '//src/qq/rpc-backend:rpc-backend',
        'third-party//by-name/mi/mimalloc:rust',

        # rust dependencies
        'third-party//rust:anyhow',
        'third-party//rust:clap',
        'third-party//rust:jj-lib',
        'third-party//rust:jj-cli',
    ],
    visibility = [ 'PUBLIC' ],
)

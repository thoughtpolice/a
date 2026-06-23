# SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

load("@root//buck/shims:shims.bzl", depot = "shims")

depot.rust_library(
    name = 'rpc-backend',
    crate = 'qq_rpc_backend',
    srcs = glob(['*.rs']),
    crate_root = 'lib.rs',
    deps = [
        # rust dependencies
        'third-party//rust:async-trait',
        'third-party//rust:futures',
        'third-party//rust:http',
        'third-party//rust:http-body-util',
        'third-party//rust:hyper',
        'third-party//rust:hyper-util',
        'third-party//rust:jj-lib',
        'third-party//rust:pollster',
        'third-party//rust:prost',
        'third-party//rust:thiserror',
        'third-party//rust:tokio',
    ],
    visibility = [ 'PUBLIC' ],
)

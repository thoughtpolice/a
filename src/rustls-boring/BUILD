# SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

load("@root//buck/shims:shims.bzl", depot="shims")

depot.rust_library(
    name = 'rustls-boring',
    srcs = glob(['*.rs']),
    crate_root = 'lib.rs',
    deps = [
        'third-party//rust:rustls',
        'third-party//rust:openssl',
        'third-party//rust:zeroize',
        'third-party//by-name/bo/boringssl/rust:bssl-sys',
    ],
    visibility = [ 'PUBLIC' ],
)

depot.rust_test_internal(
    name = 'test',
    srcs = glob(['*.rs']),
    crate_root = 'lib.rs',
    deps = [
        'third-party//rust:rustls',
        'third-party//rust:openssl',
        'third-party//rust:zeroize',
        'third-party//by-name/bo/boringssl/rust:bssl-sys',
    ],
)

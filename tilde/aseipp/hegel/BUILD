# SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

load("@root//buck/shims:shims.bzl", depot = "shims")

depot.rust_test_internal(
    name = 'tests',
    srcs = ['demo.rs'],
    crate_root = 'demo.rs',
    deps = [
        'third-party//by-name/mi/mimalloc:rust',
        'third-party//rust:hegeltest',
    ],
)

# SPDX-FileCopyrightText: © 2024-2025 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

load("@root//buck/shims:shims.bzl", depot = "shims")

depot.rust_binary(
    name = 'salsalog',
    srcs = glob(['*.rs']),
    deps = [
        'third-party//mimalloc:rust',
        'third-party//rust:salsa',
    ],
)

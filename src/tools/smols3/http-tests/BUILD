# SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

load("@root//buck/shims:shims.bzl", depot="shims")

DEPS = [
    '//src/tools/smols3/store:store',
    '//src/tools/smols3/testing:testing',
    'third-party//rust:bytes',
    'third-party//rust:http',
    'third-party//rust:http-body-util',
    'third-party//rust:s3s',
    'third-party//rust:tempfile',
    'third-party//rust:tokio',
]

depot.rust_test(
    name = 'http-tests',
    srcs = glob(['*.rs']),
    deps = DEPS,
)

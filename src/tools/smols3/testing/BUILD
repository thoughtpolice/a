# SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

load("@root//buck/shims:shims.bzl", depot="shims")

DEPS = [
    '//src/tools/smols3/store:store',
    'third-party//rust:async-trait',
    'third-party//rust:bytes',
    'third-party//rust:futures',
    'third-party//rust:hex',
    'third-party//rust:hmac',
    'third-party//rust:http',
    'third-party//rust:http-body-util',
    'third-party//rust:s3s',
    'third-party//rust:sha2',
    'third-party//rust:tokio',
    'third-party//rust:tower',
]

depot.rust_library(
    name = 'testing',
    srcs = glob(['*.rs']),
    deps = DEPS,
    visibility = ['//src/tools/smols3/...'],
)

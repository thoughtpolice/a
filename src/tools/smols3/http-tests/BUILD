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

SRCS = glob(['*.rs'])

# Split tests by backend for parallel execution.
# Each test binary runs both raw and chunking-wrapped variants of its backend.

depot.rust_test(
    name = 'http-tests-memory',
    srcs = SRCS,
    deps = DEPS,
    features = ['memory'],
)

depot.rust_test(
    name = 'http-tests-fjall',
    srcs = SRCS,
    deps = DEPS,
    features = ['fjall'],
)

depot.rust_test(
    name = 'http-tests-slatedb',
    srcs = SRCS,
    deps = DEPS,
    features = ['slatedb'],
)

depot.test_suite(
    name = 'http-tests',
    tests = [
        ':http-tests-memory',
        ':http-tests-fjall',
        ':http-tests-slatedb',
    ],
)

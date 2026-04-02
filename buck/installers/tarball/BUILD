# SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

load("@root//buck/shims:shims.bzl", depot = "shims")
load("//buck/installers:defs.bzl", "installable")

COMMON_DEPS = [
    '//buck/installers/common:common',
    'third-party//rust:anyhow',
    'third-party//rust:clap',
    'third-party//rust:flate2',
    'third-party//rust:tar',
    'third-party//rust:tokio',
    'third-party//rust:tracing',
    'third-party//rust:uuid',
]

ALL_TESTS = [
    ':tarball-tests',
]

depot.rust_binary(
    name = 'tarball',
    srcs = ['main.rs'],
    deps = COMMON_DEPS,
    tests = ALL_TESTS,
)

depot.rust_test(
    name = 'tarball-tests',
    srcs = ['main.rs'],
    deps = COMMON_DEPS + [
        'third-party//rust:tempfile',
    ],
)

depot.genrule(
    name = 'hello.txt',
    cmd = 'echo "hello from tarball installer" > $OUT',
    out = 'hello.txt',
)

depot.genrule(
    name = 'world.txt',
    cmd = 'echo "world from tarball installer" > $OUT',
    out = 'world.txt',
)

installable(
    name = 'tarball-demo',
    installer = ':tarball',
    files = {
        'greetings/hello.txt': ':hello.txt',
        'greetings/world.txt': ':world.txt',
    },
)

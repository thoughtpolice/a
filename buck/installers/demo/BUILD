# SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

load("@root//buck/shims:shims.bzl", depot = "shims")
load("//buck/installers:defs.bzl", "installable")

depot.rust_binary(
    name = 'demo',
    srcs = ['main.rs'],
    deps = [
        '//buck/installers/common:common',
        'third-party//rust:anyhow',
        'third-party//rust:clap',
        'third-party//rust:tokio',
        'third-party//rust:tracing',
        'third-party//rust:uuid',
    ],
)

depot.genrule(
    name = 'hello.txt',
    cmd = 'echo "hello from buck2 install" > $OUT',
    out = 'hello.txt',
)

installable(
    name = 'demo-test',
    installer = ':demo',
    files = {
        'hello.txt': ':hello.txt',
    },
)

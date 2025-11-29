# SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

load("@root//buck/shims:shims.bzl", depot="shims")

depot.alias(
    name = 'cache-server',
    actual = ':buck2-cache-server',
    visibility = [ 'PUBLIC' ],
)

depot.rust_binary(
    name = 'buck2-cache-server',
    srcs = glob(['src/**/*.rs']),
    deps = [
        # 3p deps
        'third-party//mimalloc:rust',
        # crates.io
        'third-party//rust:clap',
        'third-party//rust:console-subscriber',
        'third-party//rust:hex',
        'third-party//rust:prost',
        'third-party//rust:prost-types',
        'third-party//rust:sha2',
        'third-party//rust:tokio',
        'third-party//rust:tokio-stream',
        'third-party//rust:tonic',
        'third-party//rust:tonic-prost',
        'third-party//rust:tonic-health',
        'third-party//rust:tonic-reflection',
        'third-party//rust:tracing',
        'third-party//rust:tracing-subscriber',
    ],
    env = {
        'PROTOBUFS': '$(location :protos.rs)',
    },
    visibility = [ 'PUBLIC' ],
)

depot.rust_binary(
    name = 'gen-protos',
    srcs = ['build.rs'],
    crate_root = "build.rs",
    deps = [
        'third-party//rust:tonic-prost-build',
        'third-party//rust:tonic-prost',
    ],
    visibility = [],
)

depot.genrule(
    name = 'protos.rs',
    cmd = "$(exe :gen-protos)",
    out = ".",
    srcs = glob(['protos/**/*.proto']),
    env = {
        'PROTOC': depot.select({
            'config//cpu:arm64': depot.select({
                'config//os:linux': '$(location :protoc-bin-vendored.tar.gz[protoc-bin-vendored-linux-aarch_64/bin/protoc])',
                'config//os:macos': '$(location :protoc-bin-vendored.tar.gz[protoc-bin-vendored-macos-x86_64/bin/protoc])',
            }),
            'config//cpu:x86_64': depot.select({
                'config//os:linux': '$(location :protoc-bin-vendored.tar.gz[protoc-bin-vendored-linux-x86_64/bin/protoc])',
                'config//os:windows': '$(location :protoc-bin-vendored.tar.gz[protoc-bin-vendored-win32/bin/protoc.exe])',
            })
        }),
        'PROTOC_INCLUDE': depot.select({
            'config//cpu:arm64': depot.select({
                'config//os:linux': '$(location :protoc-bin-vendored.tar.gz[protoc-bin-vendored-linux-aarch_64/include])',
                'config//os:macos': '$(location :protoc-bin-vendored.tar.gz[protoc-bin-vendored-macos-x86_64/include])',
            }),
            'config//cpu:x86_64': depot.select({
                'config//os:linux': '$(location :protoc-bin-vendored.tar.gz[protoc-bin-vendored-linux-x86_64/include])',
                'config//os:windows': '$(location :protoc-bin-vendored.tar.gz[protoc-bin-vendored-win32/include])',
            })
        })
    },
    visibility = [],
)

depot.http_archive(
    name = 'protoc-bin-vendored.tar.gz',
    sha256 = '08f5cc8f522af7ba8f9f1a81f93bba94cef9312e5e644df4ecc08ea7ce9c40f7',
    urls = [
        'https://github.com/stepancheg/rust-protoc-bin-vendored/archive/20ebfb74aad5fb0f084ca2c2ebc0885b4ad18430.tar.gz',
    ],
    type = 'tar.gz',
    strip_prefix = 'rust-protoc-bin-vendored-20ebfb74aad5fb0f084ca2c2ebc0885b4ad18430',
    sub_targets = [
        'protoc-bin-vendored-linux-aarch_64/bin/protoc',
        'protoc-bin-vendored-linux-aarch_64/include',
        'protoc-bin-vendored-linux-x86_64/bin/protoc',
        'protoc-bin-vendored-linux-x86_64/include',
        'protoc-bin-vendored-macos-x86_64/bin/protoc',
        'protoc-bin-vendored-macos-x86_64/include',
        'protoc-bin-vendored-win32/bin/protoc.exe',
        'protoc-bin-vendored-win32/include',
    ],
    visibility = [],
)

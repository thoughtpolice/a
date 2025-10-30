# SPDX-FileCopyrightText: © 2024-2025 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

load("@root//buck/shims:shims.bzl", "shims")
load(":defs.bzl", "download_deno", "deno_toolchain")

DENO_VERSION = '2.5.6'

ALL_DENO_VERSIONS = {
    '2.5.6': [
        ('aarch64-unknown-linux-gnu', 'f5e60ae3dfceb61e5e5a41f22129e40a8bc17f6393b59e75d7ca19ceef32d824'),
        ('aarch64-apple-darwin', '32a5b2bcf49432715719c7c769529269fbd08cafdc059b7cecd42f9d771059ab'),
        ('x86_64-unknown-linux-gnu', 'fd4f6abc1b6a134fa9a4dba56519f1631f44c88e04e4e3e9a8ff5975dfa66e1a'),
        ('x86_64-pc-windows-msvc', '1327356cd63e23d0da7d11d5f5ca6b45902b1b62ee2debd4fbbd0aad2aab9786'),
    ],
}

[
    download_deno(version = version, hashes = hashes)
    for version, hashes in ALL_DENO_VERSIONS.items()
]

[
    deno_toolchain(
        name = f'deno-{version}',
        deno = shims.select({
            'config//cpu:arm64': shims.select({
                'config//os:linux': [ f'$(location :{version}-aarch64-unknown-linux-gnu)/deno' ],
                'config//os:macos': [ f'$(location :{version}-aarch64-apple-darwin)/deno' ],
            }),
            'config//cpu:x86_64': shims.select({
                'config//os:linux':   [ f'$(location :{version}-x86_64-unknown-linux-gnu)/deno' ],
                'config//os:windows': [ f'$(location :{version}-x86_64-pc-windows-msvc)/deno.exe' ],
            }),
        }),
    ) for version in ALL_DENO_VERSIONS.keys()
]

shims.toolchain_alias(
    name = 'deno',
    actual = f':deno-{DENO_VERSION}',
)

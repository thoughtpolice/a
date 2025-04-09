# SPDX-FileCopyrightText: © 2024-2025 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

load(":defs.bzl", "download_deno", "deno_toolchain")

DENO_VERSION = '2.1.10'

ALL_DENO_VERSIONS = {
    '2.1.10': [
        ('aarch64-unknown-linux-gnu', 'ee01a21a2b6ebd1aaa7d349b5e05238bfb5f4b3062a225ba78f591e242b973e3'),
        ('aarch64-apple-darwin', 'd33fe472cd93bbabcdfbcb5cb9806cf49e3a862365963aef323bafb9d7326bf4'),
        ('x86_64-unknown-linux-gnu', '55d18bf969b7ac6e132b3a35f31f8f01c0bd9c0e847e05b459f40384ce746cc1'),
        ('x86_64-pc-windows-msvc', '6a5e82c9796bdaa8da0626c2e4c0f960d4da7028775003b3b81eeb88238a2f47'),
    ],
}

[
    download_deno(version = version, hashes = hashes)
    for version, hashes in ALL_DENO_VERSIONS.items()
]

[
    deno_toolchain(
        name = f'deno-{version}',
        deno = select({
            'config//cpu:arm64': select({
                'config//os:linux': [ f'$(location :{version}-aarch64-unknown-linux-gnu)/deno' ],
                'config//os:macos': [ f'$(location :{version}-aarch64-apple-darwin)/deno' ],
            }),
            'config//cpu:x86_64': select({
                'config//os:linux':   [ f'$(location :{version}-x86_64-unknown-linux-gnu)/deno' ],
                'config//os:windows': [ f'$(location :{version}-x86_64-pc-windows-msvc)/deno.exe' ],
            }),
        }),
    ) for version in ALL_DENO_VERSIONS.keys()
]

toolchain_alias(
    name = 'deno',
    actual = f':deno-{DENO_VERSION}',
)

# SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

load("@root//buck/shims:shims.bzl", "shims")
load(":defs.bzl", "download_deno", "deno_toolchain")

DENO_VERSION = '2.7.12'

ALL_DENO_VERSIONS = {
    '2.7.12': [
        ('aarch64-unknown-linux-gnu', '4116c1bb5fa2bba348a1f89c5392d5ecdbb505dd7166796870660556ea6c6c53'),
        ('aarch64-apple-darwin', '4694916acf93954611339618f19dfec01d8128d9a11402838e65be76e572bc5e'),
        ('x86_64-unknown-linux-gnu', '4646ec32b4296fdf963a62a3df3d57e342a3c70376976e5690c34d42e23a3080'),
        ('x86_64-pc-windows-msvc', 'f0db746796ff2155444e4b6b42b24ff1139882626e2cdc3943743a7980f4bc2a'),
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

# Export deno runtime binaries for use in containers
[
    shims.filegroup(
        name = f'deno-runtime-{triple}',
        srcs = [f':{DENO_VERSION}-{triple}'],
        visibility = ['PUBLIC'],
    ) for triple in [
        'aarch64-unknown-linux-gnu',
        'aarch64-apple-darwin',
        'x86_64-unknown-linux-gnu',
        'x86_64-pc-windows-msvc',
    ]
]

# SPDX-FileCopyrightText: © 2024-2025 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

load("@root//buck/shims/shims.bzl", "shims")
load(":defs.bzl", "download_deno", "deno_toolchain")

DENO_VERSION = '2.3.5'

ALL_DENO_VERSIONS = {
    '2.3.5': [
        ('aarch64-unknown-linux-gnu', '8b5c2495aa2e8763acb6fe6f5b03feda4af31a1f2628dede1e41f82a8b950366'),
        ('aarch64-apple-darwin', 'c4b97b260d534b27bd31d0dac1e7d8dd83375b08510d7889b38b734ee932bb75'),
        ('x86_64-unknown-linux-gnu', '096ddb8b151adb26f34ac6a8f2beb774776e4b80173824181eb2d2f81e00d111'),
        ('x86_64-pc-windows-msvc', 'aeebfb104074b94b0fc35a52b306be3ad4275d0f871263b74d0740e9e27e56d2'),
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

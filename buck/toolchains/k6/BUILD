# SPDX-FileCopyrightText: © 2025 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

load("@root//buck/shims:shims.bzl", "shims")
load(":defs.bzl", "download_k6", "k6_toolchain")

K6_VERSION = '1.3.0'

ALL_K6_VERSIONS = {
    '1.3.0': [
        ('linux-amd64', '84d26fc1f7bc03e02f2e016b3b1b20c032e05dfe461fca82de4e3a6ebe72ddbd'),
        ('linux-arm64', 'df35a88b5ef534b39f4ab74b22a0d60362138af219228253f042650a36af7920'),
    ],
}

[
    download_k6(version = version, hashes = hashes)
    for version, hashes in ALL_K6_VERSIONS.items()
]

[
    k6_toolchain(
        name = f'k6-{version}',
        k6 = shims.select({
            'config//cpu:arm64': [ f'$(location :{version}-linux-arm64)/k6-v{version}-linux-arm64/k6' ],
            'config//cpu:x86_64': [ f'$(location :{version}-linux-amd64)/k6-v{version}-linux-amd64/k6' ],
        }),
    ) for version in ALL_K6_VERSIONS.keys()
]

shims.toolchain_alias(
    name = 'k6',
    actual = f':k6-{K6_VERSION}',
)

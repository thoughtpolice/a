# SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

load("@root//buck/shims:shims.bzl", "shims")
load(":defs.bzl", "hermetic_go_toolchain")

GO_VERSION = '1.26.5'

ALL_GO_VERSIONS = {
    '1.26.5': [
        ('linux-amd64', '5c2c3b16caefa1d968a94c1daca04a7ca301a496d9b086e17ad77bb81393f053'),
        ('linux-arm64', 'fe4789e92b1f33358680864bbe8704289e7bb5fc207d80623c308935bd696d49'),
        ('darwin-arm64', 'efb87ff28af9a188d0536ef5d42e63dd52ba8263cd7344a993cc48dd11dedb6a'),
        ('windows-amd64', '97e6b2a833b6d89f9ff17d25419ac0a7e3b482a044e9ab18cdef834bd834fd38'),
    ],
}

[
    hermetic_go_toolchain(version = version, hashes = hashes)
    for version, hashes in ALL_GO_VERSIONS.items()
]

shims.toolchain_alias(
    name = 'go',
    actual = f':go-{GO_VERSION}',
)

shims.toolchain_alias(
    name = 'go_bootstrap',
    actual = f':go_bootstrap-{GO_VERSION}',
)

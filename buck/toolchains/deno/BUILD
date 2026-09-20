# SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

load("@root//buck/shims:shims.bzl", "shims")
load(":defs.bzl", "deno_toolchain", "download_deno")

DENO_VERSION = "2.9.7"

ALL_DENO_VERSIONS = {
    "2.9.7": [
        ("aarch64-unknown-linux-gnu", "c832298b1ad4422481334855f6003e0f54145762c5a134f20a489511d2f65bbf"),
        ("aarch64-apple-darwin", "5cd46d6268f6f78f5d88bdc7159d20bd44cdaa4b3303474839f87ec6fe7ae25c"),
        ("x86_64-unknown-linux-gnu", "c6527f24f4b16031d3ae4fa9f658d5f11534c8d84ce7dc8502420280919c3490"),
        ("x86_64-pc-windows-msvc", "a0c3101b4158d1dfb7d6a78a7bf0f3de80c96bb423c152beec8beb22786f2238"),
    ],
}

[
    download_deno(
        hashes = hashes,
        version = version,
    )
    for version, hashes in ALL_DENO_VERSIONS.items()
]

[
    deno_toolchain(
        name = "deno-{version}".format(version = version),
        deno = shims.select({
            "config//cpu:arm64": shims.select({
                "config//os:linux": ["$(location :{version}-aarch64-unknown-linux-gnu)/deno".format(version = version)],
                "config//os:macos": ["$(location :{version}-aarch64-apple-darwin)/deno".format(version = version)],
            }),
            "config//cpu:x86_64": shims.select({
                "config//os:linux": ["$(location :{version}-x86_64-unknown-linux-gnu)/deno".format(version = version)],
                "config//os:windows": ["$(location :{version}-x86_64-pc-windows-msvc)/deno.exe".format(version = version)],
            }),
        }),
    )
    for version in ALL_DENO_VERSIONS.keys()
]

shims.toolchain_alias(
    name = "deno",
    actual = ":deno-{DENO_VERSION}".format(DENO_VERSION = DENO_VERSION),
)

# Export deno runtime binaries for use in containers
[
    shims.filegroup(
        name = "deno-runtime-{triple}".format(triple = triple),
        srcs = [":{DENO_VERSION}-{triple}".format(
            DENO_VERSION = DENO_VERSION,
            triple = triple,
        )],
        visibility = ["PUBLIC"],
    )
    for triple in [
        "aarch64-unknown-linux-gnu",
        "aarch64-apple-darwin",
        "x86_64-unknown-linux-gnu",
        "x86_64-pc-windows-msvc",
    ]
]

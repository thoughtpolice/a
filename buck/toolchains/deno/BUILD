# SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

load("@root//buck/shims:shims.bzl", "shims")
load(":defs.bzl", "deno_toolchain", "download_deno")

DENO_VERSION = "2.9.5"

ALL_DENO_VERSIONS = {
    "2.9.5": [
        ("aarch64-unknown-linux-gnu", "6b7cae3a8fc4385a59dea3146fcb8bad7fea4230e0ad36a8c692afacbc254be0"),
        ("aarch64-apple-darwin", "b796aadd131f6930560c1ee040cf0d6f53933fbb987464e9ff46bd7ea4830615"),
        ("x86_64-unknown-linux-gnu", "8b010a3b1a4a0188a67cdb8a7a27348b2a501af78aec7fc74f2ace167368d530"),
        ("x86_64-pc-windows-msvc", "171efab55ac6b9881fd53ee4c20f8bf3bb1340ffc618483746909014db12216a"),
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

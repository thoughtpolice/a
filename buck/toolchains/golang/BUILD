# SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

load("@root//buck/shims:shims.bzl", "shims")
load(":defs.bzl", "hermetic_go_toolchain")

GO_VERSION = "1.27.3"

ALL_GO_VERSIONS = {
    "1.27.3": [
        ("linux-amd64", "65efbc80fdc1fa2cd2631cad5b481777a68e8725f34e89f50fc6ac714e379b40"),
        ("linux-arm64", "a06e99309dbcbdca1a8ccd2282c3ee146e55930886e26b4f1193269587165f49"),
        ("darwin-arm64", "dd3908cf20959d798c1e06ebe5b72213f0505ce01373b40ce3110975a6cd99c2"),
        ("windows-amd64", "f26081f438319757f8a1b46d7d0b2c5ec7583d4038e485e0aa725cfde7885fff"),
    ],
}

[
    hermetic_go_toolchain(
        hashes = hashes,
        version = version,
    )
    for version, hashes in ALL_GO_VERSIONS.items()
]

shims.toolchain_alias(
    name = "go",
    actual = ":go-{GO_VERSION}".format(GO_VERSION = GO_VERSION),
)

shims.toolchain_alias(
    name = "go_bootstrap",
    actual = ":go_bootstrap-{GO_VERSION}".format(GO_VERSION = GO_VERSION),
)

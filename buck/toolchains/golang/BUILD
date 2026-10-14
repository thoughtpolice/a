# SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

load("@root//buck/shims:shims.bzl", "shims")
load(":defs.bzl", "hermetic_go_toolchain")

GO_VERSION = "1.27.2"

ALL_GO_VERSIONS = {
    "1.27.2": [
        ("linux-amd64", "ecbadb99091a3f46e31f5f934b068b1864eafa7995211b39eaddf76996045fe5"),
        ("linux-arm64", "94f3e30b8e374bc285e7dadc11e0865726b9bc6e85b841ccceaabc0214c6b7c8"),
        ("darwin-arm64", "76812b213b1b2302c978d28fa52fa92d541704b9e7d9d5db8002c50e4018c4c5"),
        ("windows-amd64", "1314008898bd40df77af4b014f777f08873dbdfbcd3d92308728ee03304fe04f"),
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

# SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

load("@root//buck/shims:shims.bzl", "shims")
load(":defs.bzl", "default_platforms", "generate_platforms")

generate_platforms(default_platforms)

[
    shims.platform(
        name = "{arch}-{name}".format(
            name = name,
            arch = arch,
        ),
        constraint_values = [
            "toolchains//cfg/target:target[{arch}-unknown-{name}]".format(
                name = name,
                arch = arch,
            ),
        ],
        deps = [":default"],
    )
    for name in [
        "linux-gnu",
        "uefi",
    ]
    for arch in [
        "aarch64",
        "x86_64",
    ]
]

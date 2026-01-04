# SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

load("@root//buck/shims:shims.bzl", "shims")
load(":defs.bzl", "generate_platforms", "default_platforms")

generate_platforms(default_platforms)

[
    shims.platform(
        name = f'{arch}-{name}',
        deps = [ ':default' ],
        constraint_values = [
            f'toolchains//cfg/target:target[{arch}-unknown-{name}]',
        ],
    ) for name in [ 'linux-gnu', 'uefi' ]
      for arch in [ 'aarch64', 'x86_64' ]
]

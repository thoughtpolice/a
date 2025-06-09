# SPDX-FileCopyrightText: © 2024-2025 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

load("@prelude//utils/buckconfig.bzl", "read_choice")
load("@root//buck/shims/shims.bzl", depot = "shims")
load(":defs.bzl", "generate_platforms", "default_platforms")

build_config = read_choice("project", "buildmode", [
    "debug",
    "release",
], "debug")

default_configs = [
    # build mode: debug or release
    ('mode//:{}'.format(build_config)),
]

default_constraints = [
    # build mode: debug or release
    'mode//:build-mode-{}'.format(build_config),
]

generate_platforms(default_platforms, default_configs)

[
    depot.platform(
        name = f'{arch}-{name}',
        deps = [ ':default' ],
        constraint_values = [
            f'toolchains//cfg/target/constraint:{arch}-unknown-{name}',
        ],
    ) for name in [ 'linux-gnu', 'uefi' ]
      for arch in [ 'aarch64', 'x86_64' ]
]

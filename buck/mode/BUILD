# SPDX-FileCopyrightText: © 2024-2025 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

load("@root//buck/shims/shims.bzl", depot = "shims")

MODES = [ 'debug', 'release' ]

depot.constraint(name = 'build-mode', values = [f'build-mode-{name}' for name in MODES])

[
    depot.config_setting(
        name = name,
        constraint_values = [ f'mode//:build-mode-{name}' ]
    ) for name in MODES
]

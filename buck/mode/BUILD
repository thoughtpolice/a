# SPDX-FileCopyrightText: © 2024-2025 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

MODES = [ 'debug', 'release' ]

constraint_setting(name = 'build-mode')

[
    constraint_value(
        name = f'build-mode-{name}',
        constraint_setting = ':build-mode'
    ) for name in MODES
]

[
    config_setting(
        name = name,
        constraint_values = [ f'mode//:build-mode-{name}' ]
    ) for name in MODES
]

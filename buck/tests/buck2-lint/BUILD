# SPDX-FileCopyrightText: © 2024-2025 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

load("@root//buck/shims:shims.bzl", "shims")

SOURCE_DIRS = [
    'src',
    # FIXME (aseipp): can't list buck/prelude here, since it might have extra
    # junk inside if it's expanded.
    'buck/bin',
    'buck/mode',
    'buck/platforms',
    'buck/shims',
    'buck/tests',
    'buck/third-party',
    'buck/toolchains',
]

shims.command_test(
    name = 'lint',
    cmd = [
        'dotslash',
        '$(location //buck/bin:buck2)',
        '--isolation-dir', 'buck2-lint-tests',
        'starlark',
        'lint',
    ] + SOURCE_DIRS,
)

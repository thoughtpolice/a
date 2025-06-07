# SPDX-FileCopyrightText: © 2024-2025 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

load("@root//buck/shims/shims.bzl", "shims")

shims.command_test(
    name = 'semgrep',
    cmd = [
        'semgrep',
        '--config=etc/semgrep/',
        'src',
    ],
)

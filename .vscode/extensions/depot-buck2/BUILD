# SPDX-FileCopyrightText: © 2024-2025 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

load("@root//buck/shims/shims.bzl", "shims")
load(":defs.bzl", "ncc_bundle")

ncc_bundle(
    name = 'depot-buck2',
    srcs = [
        'package.json',
        'package-lock.json',
        'tsconfig.json',
    ] + glob([
        'src/**/*.ts',
    ]),
)

shims.command(
    name = 'build',
    cmd = [
        'install',
        '-D', '$(location :depot-buck2)',
        '.vscode/extensions/depot-buck2/out/index.js'
    ],
)

shims.command(
    name = 'dev',
    cmd = [ 'npm', '--prefix', '.vscode/extensions/depot-buck2', 'install' ],
)

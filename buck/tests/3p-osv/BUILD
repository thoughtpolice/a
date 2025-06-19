# SPDX-FileCopyrightText: © 2024-2025 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

load("@root//buck/shims:shims.bzl", "shims")
load("@toolchains//deno:defs.bzl", "deno")

ALL_TESTS = [
    'generic',
    'rust',
]

[
    deno.binary(
        name = name,
        main = f'{name}.ts',
        type = 'run',
        permissions = [ 'read', 'run', 'net' ],
        tests = [ f':{name}-3p-check' ],
    ) for name in ALL_TESTS
]

[
    shims.run_test(name = f'{name}-3p-check', dep = f':{name}')
    for name in ALL_TESTS
]

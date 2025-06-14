# SPDX-FileCopyrightText: © 2024-2025 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

load("@prelude//paths.bzl", "paths")
load("@root//buck/shims/shims.bzl", depot="shims")

depot.cxx_library(
    name = 'crypto',
    header_namespace = "crypto",
    exported_headers = {
        'gimli.h': 'src/crypto/gimli.h',
        'strobe.h': 'src/crypto/strobe.h',
    },
    srcs = glob([ 'src/crypto/*.c' ]),
)

depot.cxx_library(
    name = 'util',
    header_namespace = "util",
    exported_headers = {
        'co.h': 'src/util/co.h',
        'file_size.h': 'src/util/file_size.h',
        'log.h': 'src/util/log.h',
        'macros.h': 'src/util/macros.h',
        'password.h': 'src/util/password.h',
        'vsb.h': 'src/util/vsb.h',
    },
    srcs = glob([ 'src/util/*.c' ]),

    deps = [
        'third-party//mimalloc:mimalloc',
    ] + [
        ':crypto',
    ],
    target_compatible_with = [ 'config//os:linux' ],
)

depot.cxx_library(
    name = 'io',
    header_namespace = "io",
    exported_headers = {
        'ring.h': 'src/io/ring.h',
        'async.h': 'src/io/async.h',
    },
    srcs = glob([ 'src/io/*.c' ]),

    deps = [
        'third-party//mimalloc:mimalloc',
        'third-party//liburing:liburing',
    ] + [
        ':crypto',
        ':util',
    ],
    target_compatible_with = [ 'config//os:linux' ],
)

depot.cxx_binary(
    name = 'copy-file',

    srcs = glob([ 'copy-file/*.c' ]),
    deps = [
        ':crypto',
        ':io',
        ':util',
    ] + [
        'third-party//mimalloc:mimalloc',
        'third-party//liburing:liburing',
    ],
    target_compatible_with = [ 'config//os:linux' ],
)

TESTS = [ 'gimli', 'co' ]

native.test_suite(name = 'tests', tests = [ ':test-{}'.format(t) for t in TESTS ], target_compatible_with = [ 'config//os:linux' ])

[
    depot.cxx_binary(
        name = 'test-{}-exe'.format(t),
        srcs = [ 't/{}.c'.format(t) ],
        deps = [
            ':util',
            ':crypto',
        ] + [
            'third-party//mimalloc:mimalloc',
            'third-party//liburing:liburing',
        ],
        target_compatible_with = [ 'config//os:linux' ],
    ) for t in TESTS
]

[
    depot.command_test(
        name = 'test-{}'.format(t),
        cmd = [ '$(exe :test-{}-exe)'.format(t) ],
        target_compatible_with = [ 'config//os:linux' ],
    ) for t in TESTS
]

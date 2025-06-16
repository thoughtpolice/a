# SPDX-FileCopyrightText: © 2024-2025 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

load("@prelude//:paths.bzl", "paths")
load("@root//buck/shims:shims.bzl", depot="shims")

depot.cxx_library(
    name = 'libedsign',
    header_namespace = "libedsign",
    exported_headers = {
        'edsign.h': 'inc/edsign.h'
    },
    headers = {
        paths.basename(fullpath): fullpath
            for fullpath in glob(['src/*.h'])
    },
    tests = [ ':tests' ],
    srcs = glob([ 'src/*.c' ]),
    visibility = [ 'PUBLIC' ],
)

TESTS = [ paths.basename(t).removesuffix('.c') for t in glob(['t/*.c']) ]

[
    depot.cxx_binary(
        name = 'test-{}-exe'.format(t),
        srcs = [ 't/{}.c'.format(t) ],
        deps = [ ':libedsign' ],
    ) for t in TESTS
]

[
    depot.command_test(
        name = 'test-{}'.format(t),
        cmd = [ '$(exe :test-{}-exe)'.format(t) ],
    ) for t in TESTS
]

depot.test_suite(name = 'tests', tests = [ ':test-{}'.format(t) for t in TESTS ])

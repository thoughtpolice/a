# SPDX-FileCopyrightText: © 2023 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

load("@root//buck/shims:shims.bzl", "shims")
load("@root//buck/shims:package.bzl", "pkg")

http_file(
    name = 'wuffs.c',
    sha256 = "ca10c422ebd4bf9f2cc469bafec4d5606eed3db0db7cbe21cb5232249ac0fe68",
    urls = [
        'https://raw.githubusercontent.com/google/wuffs/v{fullver}/release/c/wuffs-v{shortver}.c'
            .format(
                fullver = pkg.version(),
                shortver = pkg.version().rsplit(".", 1)[0],
            ),
    ],
)

shims.cxx_library(
    name = 'wuffs',
    header_namespace = "wuffs",
    exported_headers = {
        'wuffs.h': ':wuffs.c',
    },
    preprocessor_flags = [
        '-DWUFFS_IMPLEMENTATION=1',
    ],
    srcs = [':wuffs.c'],
    visibility = ['PUBLIC'],
    tests = [
        ':toy-genlib-test'
    ],
)

shims.cxx_binary(
    name = 'toy-genlib',
    srcs = ['toy-genlib.c'],
    deps = [':wuffs'],
)

shims.cxx_binary(
    name = 'wcat',
    srcs = ['wcat.c'],
    deps = [':wuffs'],
    visibility = ['PUBLIC'],
)

shims.command_test(
    name = 'toy-genlib-test',
    cmd = ["$(exe :toy-genlib)"],
)

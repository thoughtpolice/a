# SPDX-FileCopyrightText: © 2017-2023 Meta Platforms, Inc. and affiliates.
# SPDX-FileCopyrightText: © 2023 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

load("@root//buck/shims/shims.bzl", depot="shims")
load("@root//buck/shims/package.bzl", "pkg")

VERSION = pkg.version()

http_archive(
    name = 'src',
    sha256 = 'bb27df3402d3bd943e80d8f128aff29bef74b62d5fc6ea40977bd4af46ee87cf',
    urls = [
        'https://github.com/axboe/liburing/archive/{}.tar.gz'.format(VERSION.split('g', 1)[1]),
    ],
    type = 'tar.gz',
    strip_prefix = 'liburing-7524a6adf4d6720a47bfa617b5cb2fd8d57f16d2',
    sub_targets = [
        'src/include/liburing/barrier.h',
        'src/include/liburing/io_uring.h',
        'src/include/liburing.h',

        'src/arch/aarch64/lib.h',
        'src/arch/aarch64/syscall.h',
        'src/arch/generic/lib.h',
        'src/arch/generic/syscall.h',
        'src/arch/riscv64/lib.h',
        'src/arch/riscv64/syscall.h',
        'src/arch/x86/lib.h',
        'src/arch/x86/syscall.h',
        'src/arch/syscall-defs.h',

        'src/int_flags.h',
        'src/syscall.h',
        'src/setup.h',
        'src/lib.h',

        'src/ffi.c',
        'src/queue.c',
        'src/register.c',
        'src/setup.c',
        'src/syscall.c',
        'src/version.c',
    ]
)

depot.cxx_library(
    name = "liburing",
    visibility = ['PUBLIC'],
    header_namespace = '',
    exported_headers = {
        # in-tree files
        'liburing/io_uring_version.h': 'version.h',
        'liburing/compat.h':           'compat.h',
        # from :src tarball
        'liburing/barrier.h':  ':src[src/include/liburing/barrier.h]',
        'liburing/io_uring.h': ':src[src/include/liburing/io_uring.h]',
        'liburing.h':          ':src[src/include/liburing.h]',
    },
    headers = {
        'arch/aarch64/lib.h':     ':src[src/arch/aarch64/lib.h]',
        'arch/aarch64/syscall.h': ':src[src/arch/aarch64/syscall.h]',
        'arch/generic/lib.h':     ':src[src/arch/generic/lib.h]',
        'arch/generic/syscall.h': ':src[src/arch/generic/syscall.h]',
        'arch/riscv64/lib.h':     ':src[src/arch/riscv64/lib.h]',
        'arch/riscv64/syscall.h': ':src[src/arch/riscv64/syscall.h]',
        'arch/x86/lib.h':         ':src[src/arch/x86/lib.h]',
        'arch/x86/syscall.h':     ':src[src/arch/x86/syscall.h]',
        'arch/syscall-defs.h':    ':src[src/arch/syscall-defs.h]',

        'int_flags.h': ':src[src/int_flags.h]',
        'syscall.h':   ':src[src/syscall.h]',
        'setup.h':     ':src[src/setup.h]',
        'lib.h':       ':src[src/lib.h]',
    },
    srcs = [
        ':src[src/ffi.c]',
        ':src[src/queue.c]',
        ':src[src/register.c]',
        ':src[src/setup.c]',
        ':src[src/syscall.c]',
        ':src[src/version.c]',
    ],
    preprocessor_flags = [
        '-D_GNU_SOURCE=1',
        '-D_FILE_OFFSET_BITS=64',
        '-D_LARGEFILE_SOURCE=1',
    ],
    target_compatible_with = [
        'config//os:linux',
    ],
)

# SPDX-FileCopyrightText: © 2017-2023 Meta Platforms, Inc. and affiliates.
# SPDX-FileCopyrightText: © 2023 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

load("@root//buck/shims/shims.bzl", depot="shims")
load("@root//buck/shims/package.bzl", "pkg")

VERSION = pkg.version()

http_archive(
    name = 'src',
    sha256 = '5adfeda85961281b70c6498268bdc388990790edb245daf168830312a63fd43b',
    urls = [
        'https://github.com/compudj/librseq/archive/{}.tar.gz'.format(VERSION.split('g', 1)[1]),
    ],
    type = 'tar.gz',
    strip_prefix = 'librseq-313af7c991b598d3c6ef07aec86db799c47ac46f',
    sub_targets = [
        'include/rseq/compiler.h',
        'include/rseq/rseq-abi.h',
        'include/rseq/rseq-arm64-bits.h',
        'include/rseq/rseq-arm64.h',
        'include/rseq/rseq-arm-bits.h',
        'include/rseq/rseq-arm.h',
        'include/rseq/rseq-bits-reset.h',
        'include/rseq/rseq-bits-template.h',
        'include/rseq/rseq-generic-thread-pointer.h',
        'include/rseq/rseq.h',
        'include/rseq/rseq-mips-bits.h',
        'include/rseq/rseq-mips.h',
        'include/rseq/rseq-ppc-bits.h',
        'include/rseq/rseq-ppc.h',
        'include/rseq/rseq-ppc-thread-pointer.h',
        'include/rseq/rseq-riscv-bits.h',
        'include/rseq/rseq-riscv.h',
        'include/rseq/rseq-s390-bits.h',
        'include/rseq/rseq-s390.h',
        'include/rseq/rseq-thread-pointer.h',
        'include/rseq/rseq-x86-bits.h',
        'include/rseq/rseq-x86.h',
        'include/rseq/rseq-x86-thread-pointer.h',
        'src/rseq.c',
    ]
)

depot.cxx_library(
    name = "librseq",
    visibility = ['PUBLIC'],
    header_namespace = 'rseq',
    exported_headers = {
        'compiler.h': ':src[include/rseq/compiler.h]',
        'rseq-abi.h': ':src[include/rseq/rseq-abi.h]',
        'rseq-arm64-bits.h': ':src[include/rseq/rseq-arm64-bits.h]',
        'rseq-arm64.h': ':src[include/rseq/rseq-arm64.h]',
        'rseq-arm-bits.h': ':src[include/rseq/rseq-arm-bits.h]',
        'rseq-arm.h': ':src[include/rseq/rseq-arm.h]',
        'rseq-bits-reset.h': ':src[include/rseq/rseq-bits-reset.h]',
        'rseq-bits-template.h': ':src[include/rseq/rseq-bits-template.h]',
        'rseq-generic-thread-pointer.h': ':src[include/rseq/rseq-generic-thread-pointer.h]',
        'rseq.h': ':src[include/rseq/rseq.h]',
        'rseq-mips-bits.h': ':src[include/rseq/rseq-mips-bits.h]',
        'rseq-mips.h': ':src[include/rseq/rseq-mips.h]',
        'rseq-ppc-bits.h': ':src[include/rseq/rseq-ppc-bits.h]',
        'rseq-ppc.h': ':src[include/rseq/rseq-ppc.h]',
        'rseq-ppc-thread-pointer.h': ':src[include/rseq/rseq-ppc-thread-pointer.h]',
        'rseq-riscv-bits.h': ':src[include/rseq/rseq-riscv-bits.h]',
        'rseq-riscv.h': ':src[include/rseq/rseq-riscv.h]',
        'rseq-s390-bits.h': ':src[include/rseq/rseq-s390-bits.h]',
        'rseq-s390.h': ':src[include/rseq/rseq-s390.h]',
        'rseq-thread-pointer.h': ':src[include/rseq/rseq-thread-pointer.h]',
        'rseq-x86-bits.h': ':src[include/rseq/rseq-x86-bits.h]',
        'rseq-x86.h': ':src[include/rseq/rseq-x86.h]',
        'rseq-x86-thread-pointer.h': ':src[include/rseq/rseq-x86-thread-pointer.h]',
    },
    srcs = [':src[src/rseq.c]'],
    target_compatible_with = [
        'config//os:linux',
    ],
)

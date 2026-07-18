# SPDX-FileCopyrightText: © 2017-2023 Meta Platforms, Inc. and affiliates.
# SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

load("@root//buck/shims:package.bzl", "pkg")
load("@root//buck/shims:shims.bzl", "shims")

VERSION = pkg.version()

shims.http_archive(
    name = "src",
    sha256 = "3de6beb63ec279192e07863ca5edbdcf83686b470f6066cdaaf4bfb2192fee46",
    strip_prefix = "liburing-e3d35ea59d3ba09075ed4d7751e4bb9049cce64a",
    sub_targets = [
        "src/include/liburing/barrier.h",
        "src/include/liburing/io_uring.h",
        "src/include/liburing/sanitize.h",
        "src/include/liburing/io_uring/query.h",
        "src/include/liburing.h",
        "src/arch/aarch64/lib.h",
        "src/arch/aarch64/syscall.h",
        "src/arch/generic/lib.h",
        "src/arch/generic/syscall.h",
        "src/arch/riscv64/lib.h",
        "src/arch/riscv64/syscall.h",
        "src/arch/x86/lib.h",
        "src/arch/x86/syscall.h",
        "src/arch/syscall-defs.h",
        "src/int_flags.h",
        "src/syscall.h",
        "src/setup.h",
        "src/lib.h",
        "src/ffi.c",
        "src/queue.c",
        "src/register.c",
        "src/setup.c",
        "src/syscall.c",
        "src/version.c",
    ],
    type = "tar.gz",
    urls = [
        "https://github.com/axboe/liburing/archive/{}.tar.gz".format(VERSION.split("g", 1)[1]),
    ],
)

shims.cxx_library(
    name = "liburing",
    srcs = [
        ":src[src/ffi.c]",
        ":src[src/queue.c]",
        ":src[src/register.c]",
        ":src[src/setup.c]",
        ":src[src/syscall.c]",
        ":src[src/version.c]",
    ],
    exported_headers = {
        # in-tree files
        "liburing/io_uring_version.h": "version.h",
        "liburing/compat.h": "compat.h",
        # from :src tarball
        "liburing/barrier.h": ":src[src/include/liburing/barrier.h]",
        "liburing/io_uring.h": ":src[src/include/liburing/io_uring.h]",
        "liburing/sanitize.h": ":src[src/include/liburing/sanitize.h]",
        "liburing/io_uring/query.h": ":src[src/include/liburing/io_uring/query.h]",
        "liburing.h": ":src[src/include/liburing.h]",
    },
    header_namespace = "",
    headers = {
        "arch/aarch64/lib.h": ":src[src/arch/aarch64/lib.h]",
        "arch/aarch64/syscall.h": ":src[src/arch/aarch64/syscall.h]",
        "arch/generic/lib.h": ":src[src/arch/generic/lib.h]",
        "arch/generic/syscall.h": ":src[src/arch/generic/syscall.h]",
        "arch/riscv64/lib.h": ":src[src/arch/riscv64/lib.h]",
        "arch/riscv64/syscall.h": ":src[src/arch/riscv64/syscall.h]",
        "arch/x86/lib.h": ":src[src/arch/x86/lib.h]",
        "arch/x86/syscall.h": ":src[src/arch/x86/syscall.h]",
        "arch/syscall-defs.h": ":src[src/arch/syscall-defs.h]",
        "int_flags.h": ":src[src/int_flags.h]",
        "syscall.h": ":src[src/syscall.h]",
        "setup.h": ":src[src/setup.h]",
        "lib.h": ":src[src/lib.h]",
    },
    preprocessor_flags = [
        "-D_GNU_SOURCE=1",
        "-D_FILE_OFFSET_BITS=64",
        "-D_LARGEFILE_SOURCE=1",
    ],
    target_compatible_with = [
        "config//os:linux",
    ],
    visibility = ["PUBLIC"],
)

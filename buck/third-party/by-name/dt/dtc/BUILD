# SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

load("@root//buck/shims:package.bzl", "pkg")
load("@root//buck/shims:shims.bzl", "shims")

VERSION = pkg.version()

# The sources of LIBFDT_SRCS in libfdt/Makefile.libfdt, which libfdt/meson.build
# repeats.
LIBFDT_SRCS = [
    "fdt.c",
    "fdt_addresses.c",
    "fdt_check.c",
    "fdt_empty_tree.c",
    "fdt_overlay.c",
    "fdt_ro.c",
    "fdt_rw.c",
    "fdt_strerror.c",
    "fdt_sw.c",
    "fdt_wip.c",
]

LIBFDT_HEADERS = [
    "fdt.h",
    "libfdt.h",
    "libfdt_env.h",
]

shims.http_archive(
    name = "src",
    sha256 = "23526015a6f1550e0541a53fe7acea1b5a11e3697cdf3a3bdc076abc38f6045d",
    strip_prefix = "dtc-{}".format(VERSION),
    sub_targets = ["libfdt/" + f for f in LIBFDT_SRCS + LIBFDT_HEADERS + ["libfdt_internal.h"]],
    type = "tar.xz",
    urls = [
        "https://mirrors.edge.kernel.org/pub/software/utils/dtc/dtc-{}.tar.xz".format(VERSION),
    ],
)

# FDT_ASSUME_MASK=0 is meson's default assume-mask: libfdt checks every tree it
# is handed rather than trusting it to be well formed, which matters to QEMU,
# whose -dtb trees come from the user.
shims.cxx_library(
    name = "libfdt",
    srcs = [":src[libfdt/{}]".format(f) for f in LIBFDT_SRCS],
    exported_headers = {f: ":src[libfdt/{}]".format(f) for f in LIBFDT_HEADERS},
    header_namespace = "",
    headers = {
        "libfdt_internal.h": ":src[libfdt/libfdt_internal.h]",
    },
    preprocessor_flags = ["-DFDT_ASSUME_MASK=0"],
    visibility = ["PUBLIC"],
)

shims.cxx_binary(
    name = "test-smoke-bin",
    srcs = ["test.c"],
    deps = [":libfdt"],
)

shims.command_test(
    name = "test-smoke",
    cmd = ["$(exe :test-smoke-bin)"],
)

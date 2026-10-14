# SPDX-FileCopyrightText: © 2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

load("@root//buck/shims:package.bzl", "pkg")
load("@root//buck/shims:shims.bzl", "shims")

VERSION = pkg.version()

shims.http_archive(
    name = "src",
    sha256 = "491108728f120ce05b539934b41a750235031a6df8abc6b47e57aff7de15094d",
    strip_prefix = "patchelf-{}".format(VERSION),
    sub_targets = [
        "src/elf.h",
        "src/patchelf.cc",
        "src/patchelf.h",
    ],
    type = "tar.gz",
    urls = [
        "https://github.com/NixOS/patchelf/releases/download/{0}/patchelf-{0}.tar.gz".format(VERSION),
    ],
)

# The flags are the ones src/Makefile.am uses, and PACKAGE_STRING is what
# configure would define.
shims.cxx_binary(
    name = "patchelf",
    srcs = [":src[src/patchelf.cc]"],
    compiler_flags = [
        "-std=c++17",
        "-D_FILE_OFFSET_BITS=64",
    ],
    header_namespace = "",
    headers = {
        "elf.h": ":src[src/elf.h]",
        "patchelf.h": ":src[src/patchelf.h]",
    },
    preprocessor_flags = [
        "-DPACKAGE_STRING=\"patchelf {}\"".format(VERSION),
    ],
    visibility = ["PUBLIC"],
)

shims.command_test(
    name = "version",
    script = """
        test "`$(exe :patchelf) --version`" = "patchelf {}"
    """.format(VERSION),
)

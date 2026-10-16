# SPDX-FileCopyrightText: © 2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

load("@root//buck/shims:package.bzl", "pkg")
load("@root//buck/shims:shims.bzl", "shims")

VERSION = pkg.version()

shims.http_archive(
    name = "src",
    sha256 = "5738270935e7c3d38a79b3adf7c9692566ce7895a25f67de43ad52ab504acd32",
    strip_prefix = "xxHash-{}".format(VERSION),
    sub_targets = [
        "cli/xsum_arch.c",
        "cli/xsum_bench.c",
        "cli/xsum_os_specific.c",
        "cli/xsum_output.c",
        "cli/xsum_sanity_check.c",
        "cli/xxhsum.c",
        "xxh3.h",
        "xxh_x86dispatch.c",
        "xxhash.c",
        "xxhash.h",
    ],
    type = "tar.gz",
    urls = [
        "https://github.com/Cyan4973/xxHash/archive/refs/tags/v{}.tar.gz".format(VERSION),
    ],
)

# libxxhash as the Makefile builds it, without the x86 dispatcher, which it
# leaves out unless asked.
shims.cxx_library(
    name = "xxhash",
    srcs = [":src[xxhash.c]"],
    exported_headers = {
        "xxh3.h": ":src[xxh3.h]",
        "xxhash.h": ":src[xxhash.h]",
    },
    header_namespace = "",
    preferred_linkage = "static",
)

# The Makefile does give xxhsum the dispatcher on x86, so it picks the widest
# vector unit at run time.
shims.cxx_binary(
    name = "xxhsum",
    srcs = [
        ":src[cli/xsum_arch.c]",
        ":src[cli/xsum_bench.c]",
        ":src[cli/xsum_os_specific.c]",
        ":src[cli/xsum_output.c]",
        ":src[cli/xsum_sanity_check.c]",
        ":src[cli/xxhsum.c]",
    ] + shims.select({
        "config//cpu:x86_64": [":src[xxh_x86dispatch.c]"],
        "DEFAULT": [],
    }),
    # cli/ includes "../xxhash.h", next to itself; naming the tree makes it an
    # input of the compile.
    preprocessor_flags = ["-I$(location :src)"] + shims.select({
        "config//cpu:x86_64": ["-DXXHSUM_DISPATCH=1"],
        "DEFAULT": [],
    }),
    visibility = ["PUBLIC"],
    deps = [":xxhash"],
)

shims.cxx_binary(
    name = "test-vectors-bin",
    srcs = ["test.c"],
    deps = [":xxhash"],
)

shims.command_test(
    name = "test-vectors",
    cmd = ["$(exe :test-vectors-bin)"],
)

# `--version` runs xxhsum's own sanity check, which compares every algorithm
# against upstream's test vectors and exits non-zero on a mismatch. The digests
# of "abc" are those of the reference implementation.
shims.command_test(
    name = "test-xxhsum",
    script = """
        xxhsum=$(exe :xxhsum)
        $xxhsum --version 2>&1 | grep -q "^xxhsum {version} "
        test "`printf abc | $xxhsum -H0`" = "32d153ff  stdin"
        test "`printf abc | $xxhsum -H1`" = "44bc2cf5ad770999  stdin"
        test "`printf abc | $xxhsum -H2`" = "06b05ab6733a618578af5f94892f3950  stdin"
        test "`printf abc | $xxhsum -H3`" = "XXH3_78af5f94892f3950  stdin"
    """.format(version = VERSION),
)

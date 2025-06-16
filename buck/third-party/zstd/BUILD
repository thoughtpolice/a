# SPDX-FileCopyrightText: © 2024-2025 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

load("@root//buck/shims/shims.bzl", "shims")
load("@root//buck/shims/package.bzl", "pkg")

VERSION = pkg.version().split("g", 1)[1]

# XXX FIXME (aseipp): download the real source, not my copy of zstd i amalgamated a few months ago
shims.http_archive(
    name="src",
    sha256="3dde08c4ceb16a1de42ed4008fa52eda01fc1b8b115012e8216b9f6d910db9e5",
    urls=[
        f"https://gist.github.com/thoughtpolice/bb26bee5c02e8986760210b291e43288/archive/{VERSION}.tar.gz",
    ],
    type="tar.gz",
    strip_prefix="bb26bee5c02e8986760210b291e43288-6bcf321e242d62765c640458cd98d407e84f33a1",
    sub_targets=[
        "zstd.h",
        "zdict.h",
        "zstd_errors.h",
        "zstd.c",
    ],
)

shims.cxx_library(
    name="zstd",
    header_namespace="zstd",
    exported_headers={
        "zstd.h": ":src[zstd.h]",
        "zdict.h": ":src[zdict.h]",
        "zstd_errors.h": ":src[zstd_errors.h]",
    },
    srcs=[":src[zstd.c]"],
    preferred_linkage="static",
)

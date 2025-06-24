# SPDX-FileCopyrightText: © 2024-2025 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

load("@prelude//:paths.bzl", "paths")
load("@root//buck/shims:shims.bzl", "shims")
load("@root//buck/shims:package.bzl", "pkg")

VERSION = pkg.version()

shims.http_archive(
    name="src",
    sha256="1c6949032069d5ebea438ec5cedd602d06f40a92ddf0f0d9dcff0993e5f6635c",
    urls=[
        f"https://github.com/microsoft/mimalloc/archive/refs/tags/v{VERSION}.tar.gz",
    ],
    type="tar.gz",
    strip_prefix=f"mimalloc-{VERSION}",
    sub_targets=[
        "include/mimalloc-override.h",
        "include/mimalloc.h",
        "include/mimalloc/internal.h",
        "include/mimalloc/prim.h",
        "include/mimalloc/types.h",
        "include/mimalloc/track.h",
        "include/mimalloc/atomic.h",
        "include/mimalloc/bits.h",
        "include/mimalloc-new-delete.h",
        "include/mimalloc-stats.h",
        "src/page.c",
        "src/page-map.c",
        "src/free.c",
        "src/os.c",
        "src/libc.c",
        "src/bitmap.h",
        "src/prim/prim.c",
        "src/prim/unix/prim.c",
        "src/prim/wasi/prim.c",
        "src/prim/osx/alloc-override-zone.c",
        "src/prim/osx/prim.c",
        "src/prim/windows/prim.c",
        "src/random.c",
        "src/stats.c",
        "src/options.c",
        "src/arena-meta.c",
        "src/alloc.c",
        "src/bitmap.c",
        "src/heap.c",
        "src/alloc-aligned.c",
        "src/alloc-override.c",
        "src/static.c",
        "src/arena.c",
        "src/page-queue.c",
        "src/init.c",
        "src/alloc-posix.c",
    ],
)

# MARK: C/C++ library

shims.cxx_library(
    name="mimalloc",
    srcs=[
        ":src[src/prim/prim.c]",
        ":src[src/alloc.c]",
        ":src[src/alloc-aligned.c]",
        ":src[src/alloc-posix.c]",
        ":src[src/arena.c]",
        ":src[src/arena-meta.c]",
        ":src[src/bitmap.c]",
        ":src[src/heap.c]",
        ":src[src/init.c]",
        ":src[src/libc.c]",
        ":src[src/options.c]",
        ":src[src/os.c]",
        ":src[src/page.c]",
        ":src[src/page-map.c]",
        ":src[src/random.c]",
        ":src[src/stats.c]",
    ]
    + shims.select(
        {
            "config//os:linux": [":src[src/prim/unix/prim.c]"],
            "config//os:windows": [":src[src/prim/windows/prim.c]"],
            "config//os:macos": [
                ":src[src/prim/osx/alloc-override-zone.c]",
                ":src[src/prim/unix/prim.c]",
            ],
        }
    ),
    preferred_linkage="static",
    preprocessor_flags=[
        "-DMI_SECURE=0",
        "-DMI_DEBUG=0",
        "-DMI_STAT=2",
    ],
    header_namespace="",
    exported_headers={
        "mimalloc.h": ":src[include/mimalloc.h]",
        "mimalloc-override.h": ":src[include/mimalloc-override.h]",
        "mimalloc/internal.h": ":src[include/mimalloc/internal.h]",
        "mimalloc/prim.h": ":src[include/mimalloc/prim.h]",
        "mimalloc/types.h": ":src[include/mimalloc/types.h]",
        "mimalloc/track.h": ":src[include/mimalloc/track.h]",
        "mimalloc/atomic.h": ":src[include/mimalloc/atomic.h]",
        "mimalloc/bits.h": ":src[include/mimalloc/bits.h]",
        "mimalloc-new-delete.h": ":src[include/mimalloc-new-delete.h]",
        "mimalloc-stats.h": ":src[include/mimalloc-stats.h]",
    },
    headers={
        "bitmap.h": ":src[src/bitmap.h]",
        "page-queue.c": ":src[src/page-queue.c]",
        "alloc-override.c": ":src[src/alloc-override.c]",
        "unix/prim.c": ":src[src/prim/unix/prim.c]",
        "free.c": ":src[src/free.c]",
    },
    visibility=["PUBLIC"],
)

# MARK: C/C++ tests

CXX_TESTS = map(
    lambda f:
    # (source file, test name)
    (f, paths.basename(f).replace(".c", "")),
    glob(["test-*.c"]),
)

[
    shims.cxx_binary(
        name="{}-exe".format(t),
        srcs=[src],
        deps=[":mimalloc"],
        link_style="static",
    )
    for (src, t) in CXX_TESTS
]

[
    shims.command_test(
        name="{}".format(t),
        cmd=["$(exe :{}-exe)".format(t)],
    )
    for (_, t) in CXX_TESTS
]

# MARK: Rust tests

shims.rust_library(
    name="rust",
    crate="mimalloc",
    srcs=["lib.rs"],
    deps=[":mimalloc"],
    tests=[
        ":rust-test",
    ],
)

shims.rust_test(
    name="rust-test",
    srcs=["lib.rs"],
    deps=[":mimalloc"],
)

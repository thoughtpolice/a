# SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

load("@prelude//:paths.bzl", "paths")
load("@root//buck/shims:shims.bzl", "shims")
load("@root//buck/shims:package.bzl", "pkg")

VERSION = pkg.version()

shims.http_archive(
    name="src",
    sha256="ca02384e007f46950598500dfaebde5ff9948c1d231f5a81b058799afa64bbbb",
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
        "src/theap.c",
        "src/threadlocal.c",
    ],
)

# MARK: C/C++ library

EXPORTED_HEADERS = {
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
}

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
        ":src[src/theap.c]",
        ":src[src/threadlocal.c]",
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
    exported_headers=EXPORTED_HEADERS,
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

# Standalone binary to test statistics API and print sizes
shims.cxx_binary(
    name="test-stats-debug",
    srcs=["test-stats.c"],
    deps=[":mimalloc"],
    link_style="static",
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

# MARK: Rust bindings

shims.write_file(
    name = 'bindgen-wrapper.h',
    contents = [
        '#include "mimalloc.h"',
        '#include "mimalloc-stats.h"',
    ],
)

shims.cxx_genrule(
    name="mimalloc_ffi.rs",
    srcs=EXPORTED_HEADERS | {
        "bindgen-wrapper.h": ":bindgen-wrapper.h",
    },
    out="mimalloc_ffi.rs",
    cmd="bindgen bindgen-wrapper.h -o $OUT -- -I.",
)

shims.write_file(
    name = 'ffi_lib.rs',
    contents = [
        'mod mimalloc_ffi;',
        'pub use mimalloc_ffi::*;',
    ],
)

# layer this into a filegroup so that buck2-rust-project and rust-analyzer can
# more easily find the source code for this crate
shims.filegroup(
    name = 'mimalloc-ffi-lib-src',
    srcs = {
        'lib.rs': ':ffi_lib.rs',
        'mimalloc_ffi.rs': ':mimalloc_ffi.rs',
    },
)

shims.rust_library(
    name="mimalloc-ffi-rs",
    crate="mimalloc_ffi",
    srcs=[':mimalloc-ffi-lib-src'],
    crate_root='mimalloc-ffi-lib-src/lib.rs',
    deps=[":mimalloc"],
    tests=[":rust-test"],
)

shims.rust_library(
    name="rust",
    crate="mimalloc",
    srcs=["lib.rs"],
    deps=[":mimalloc-ffi-rs"],
    tests=[":rust-test"],
)

# MARK: Rust tests

shims.rust_test(
    name="rust-test",
    srcs=["lib.rs"],
    deps=[":mimalloc-ffi-rs"],
)

# Standalone test binary to print JSON statistics
shims.rust_binary(
    name="test-stats-print",
    srcs=["test-stats-print.rs"],
    crate_root="test-stats-print.rs",
    deps=[":rust"],
)

# Test that prints JSON statistics (also runnable as a test)
shims.rust_test(
    name="test-stats-print-test",
    srcs=["test-stats-print.rs"],
    crate_root="test-stats-print.rs",
    deps=[":rust"],
)

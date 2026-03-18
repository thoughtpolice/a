# SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

load("@root//buck/shims:shims.bzl", "shims")
load("@root//buck/shims:package.bzl", "pkg")

load(
    ":BUILD.generated.bzl",
    "bcm_internal_headers",
    "bcm_sources",
    "bcm_sources_asm",
    "bssl_internal_headers",
    "bssl_sources",
    "crypto_headers",
    "crypto_internal_headers",
    "crypto_sources",
    "crypto_sources_asm",
    "decrepit_internal_headers",
    "decrepit_sources",
    "ssl_headers",
    "ssl_internal_headers",
    "ssl_sources",
)

GIT_COMMIT = pkg.version().split("g", 1)[1]

shims.http_archive(
    name="src",
    sha256="18a8010f460ecddd9b3bf53043e75a6ee72bd6d084259cf7d344bac09729b1a5",
    urls=[
        "https://github.com/google/boringssl/archive/{}.tar.gz".format(GIT_COMMIT),
    ],
    type="tar.gz",
    strip_prefix="boringssl-{}".format(GIT_COMMIT),
    sub_targets=bcm_sources
    + bcm_internal_headers
    + bcm_sources_asm
    + crypto_sources
    + crypto_headers
    + crypto_internal_headers
    + crypto_sources_asm
    + ssl_sources
    + ssl_headers
    + ssl_internal_headers
    + decrepit_sources
    + decrepit_internal_headers
    + bssl_sources
    + bssl_internal_headers
    + [
        # rust sources
        "rust/bssl-sys/src/lib.rs",
        "rust/bssl-sys/wrapper.h",
        "rust/bssl-macros/src/lib.rs",
    ],
    visibility=["third-party//bssl/..."],
)

src_ref = lambda x: ":src[{}]".format(x)

cc_copts = [
    # Assembler option --noexecstack adds .note.GNU-stack to each object to
    # ensure that binaries can be built with non-executable stack.
    "-Wa,--noexecstack",
    # This list of warnings should match those in the top-level CMakeLists.txt.
    "-Wall",
    "-Wformat=2",
    "-Wmissing-field-initializers",
    "-Wshadow",
    "-Wsign-compare",
    "-Wtype-limits",
    "-Wvla",
    "-Wwrite-strings",
    "-fno-common",
    "-fno-strict-aliasing",
]
cc_copts_cxx = [
    "-std=c++17",
    "-Wmissing-declarations",
    "-Wnon-virtual-dtor",
]

boringssl_copts = (
    [
        "-DBORINGSSL_IMPLEMENTATION",
    ]
    + shims.select(
        {
            # We assume that non-Windows builds use a GCC-compatible toolchain and that
            # Windows builds do not.
            "config//os:windows": [],
            "DEFAULT": cc_copts,
        }
    )
    + shims.select(
        {
            # This is needed on glibc systems to get rwlock in pthreads, but it should
            # not be set on Apple platforms or FreeBSD, where it instead disables APIs
            # we use.
            # See compat(5), sys/cdefs.h, and https://crbug.com/boringssl/471
            "config//os:linux": ["-D_XOPEN_SOURCE=700"],
            # Without WIN32_LEAN_AND_MEAN, <windows.h> pulls in wincrypt.h, which
            # conflicts with our <openssl/x509.h>.
            "config//os:windows": ["-DWIN32_LEAN_AND_MEAN", "-DNOMINMAX"],
            "DEFAULT": [],
        }
    )
    + shims.select(
        {
            "config//os:windows": ["-DOPENSSL_NO_ASM"],
            "DEFAULT": [],
        }
    )
)

boringssl_copts_cxx = boringssl_copts + shims.select(
    {
        "config//os:windows": [],
        "DEFAULT": cc_copts_cxx,
    }
)

shims.cxx_library(
    name="crypto",
    srcs=map(src_ref, bcm_sources + crypto_sources)
    + shims.select(
        {
            "config//os:windows": [],
            "DEFAULT": map(src_ref, bcm_sources_asm + crypto_sources_asm),
        }
    ),
    compiler_flags=boringssl_copts_cxx,
    raw_headers=map(src_ref, crypto_internal_headers + bcm_internal_headers),
    header_namespace="",
    exported_headers={
        x: y for (x, y) in map(lambda x: (x[8:], src_ref(x)), crypto_headers)
    },
    preferred_linkage="static",
    linker_flags=shims.select(
        {
            "config//os:windows": ["-defaultlib:advapi32.lib"],
            "DEFAULT": ["-pthread"],
        }
    ),
)

shims.cxx_library(
    name="ssl",
    srcs=map(src_ref, ssl_sources),
    compiler_flags=boringssl_copts_cxx,
    raw_headers=map(src_ref, ssl_internal_headers),
    header_namespace="",
    exported_headers={
        x: y for (x, y) in map(lambda x: (x[8:], src_ref(x)), ssl_headers)
    },
    preferred_linkage="static",
    exported_linker_flags=shims.select(
        {"config//os:linux": ["-lstdc++"], "config//os:macos": ["-lc++"], "DEFAULT": []}
    ),
    deps=[":crypto"],
)

shims.cxx_library(
    name="decrepit",
    srcs=map(src_ref, decrepit_sources),
    compiler_flags=boringssl_copts_cxx,
    raw_headers=map(src_ref, decrepit_internal_headers),
    deps=[":crypto", ":ssl"],
)

shims.cxx_binary(
    name="bssl",
    srcs=map(src_ref, bssl_sources),
    raw_headers=map(src_ref, bssl_internal_headers),
    compiler_flags=boringssl_copts_cxx,
    deps=[":crypto", ":ssl", ":decrepit"],
    visibility=["PUBLIC"],
)

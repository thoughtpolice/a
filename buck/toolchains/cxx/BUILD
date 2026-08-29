# SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

load("@root//buck/shims:shims.bzl", "shims")
load(":defs.bzl", "system_cxx_toolchain")

cxx_warn_flags = shims.select({
    "config//os:macos": [
        # NOTE (aseipp): some apparently ancient zlib code in the zlib-sys crate
        # needs this, otherwise builds fail on sufficiently recent macOS systems due
        # to C2X support officially making this an error by default
        "-Wno-implicit-function-declaration",
    ],
    "DEFAULT": [],
})

cxx_base_flags = shims.select({
    "config//os:linux": [
        "-std=gnu++17",
    ],
    "config//os:macos": [
        "-std=gnu++17",
        "-stdlib=libc++",
    ],
    "config//os:windows": [
        "/std:c++17",
        "/Zc:__cplusplus",
        "/Zc:inline",
        "/Zc:wchar_t",
        "/Zc:forScope",
        "/fp:precise",
    ],
})

opt_flags = shims.select({
    "mode//:build-mode[debug]": shims.select({
        "config//os:windows": [
            "/Zi",
            "/Od",
        ],
        "DEFAULT": [
            "-g",
            "-Og",
        ],
    }),
    "mode//:build-mode[release]": shims.select({
        "config//os:windows": ["/O2"],
        "DEFAULT": ["-O3"],
    }),
})

fozzie_compiler_flags = [
    # Match optimized release behavior while retaining symbolizable locations
    # and stable stack frames.
    "-O3",
    "-gline-tables-only",
    "-fno-omit-frame-pointer",
    "-fsanitize-coverage=inline-8bit-counters,pc-table,trace-cmp",
]

instrumentation_compiler_flags = shims.select({
    "toolchains//cfg/instrumentation:instrumentation[none]": [],
    "toolchains//cfg/instrumentation:instrumentation[fozzie]": fozzie_compiler_flags,
    # ASan runtime support will be added separately. Keep this configuration
    # useful for coverage-only builds until that runtime is available.
    "toolchains//cfg/instrumentation:instrumentation[fozzie-asan]": fozzie_compiler_flags,
})

compiler_type = shims.select({
    "config//os:windows": "windows",
    "DEFAULT": "clang",
})

linker = shims.select({
    "toolchains//cfg/target:target[x86_64-unknown-uefi]": "lld",
    "toolchains//cfg/target:target[aarch64-unknown-uefi]": "lld",
    "DEFAULT": shims.select({
        "config//os:windows": "link.exe",
        "config//os:macos": "clang++",
        "DEFAULT": "clang++",
    }),
})

linux_common_ldflags = [
    # emit relocations for BOLT
    "-Wl,--emit-relocs",
    # FIXME issue: nixos/nixpkgs#347795 <https://github.com/NixOS/nixpkgs/issues/347795>
    #"-Wl,--compress-debug-sections=zstd",
] + shims.select({
    "toolchains//cfg/instrumentation:instrumentation[none]": ["-fuse-ld=mold"],
    # LLD retains the SanitizerCoverage PC table sections Fozzie consumes.
    "toolchains//cfg/instrumentation:instrumentation[fozzie]": ["-fuse-ld=lld"],
    "toolchains//cfg/instrumentation:instrumentation[fozzie-asan]": ["-fuse-ld=lld"],
})

link_flags = shims.select({
    "toolchains//cfg/target:target[x86_64-unknown-uefi]": [],
    "toolchains//cfg/target:target[aarch64-unknown-uefi]": [],
    "toolchains//cfg/target:target[x86_64-unknown-linux-gnu]": [
        "-target",
        "x86_64-unknown-linux-gnu",
    ] + linux_common_ldflags,
    "toolchains//cfg/target:target[aarch64-unknown-linux-gnu]": [
        "-target",
        "aarch64-unknown-linux-gnu",
    ] + linux_common_ldflags,
    "DEFAULT": shims.select({
        # on Windows, suffer
        "config//os:windows": [
            "advapi32.lib",
            "winhttp.lib",
            "rpcrt4.lib",
            "ole32.lib",
            "crypt32.lib",
            "secur32.lib",
            "shell32.lib",
            "user32.lib",
        ],
        "config//os:macos": [],
        # An os with no triple above it is reachable: a transition may move
        # config//os without moving the target triple, which is what a
        # cross-compiled binary built on a host whose default triple names
        # another os looks like. Claiming no flags is the only safe answer,
        # since the flags those triples want are the ones we do not have.
        "DEFAULT": [],
    }),
})

system_cxx_toolchain(
    name = "cxx",
    c_flags = cxx_warn_flags + opt_flags + instrumentation_compiler_flags,
    compiler_type = compiler_type,
    cxx_flags = cxx_base_flags + cxx_warn_flags + opt_flags + instrumentation_compiler_flags,
    link_flags = link_flags,
    linker = linker,
)

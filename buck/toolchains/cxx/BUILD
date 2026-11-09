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
    "toolchains//cfg/target:target[wasm32-unknown-unknown]": [
        "-std=gnu++17",
        "-nostdinc++",
    ],
    "DEFAULT": shims.select({
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
    }),
})

opt_flags = shims.select({
    "mode//:build-mode[debug]": shims.select({
        "config//os:windows": [
            "/Zi",
            "/Od",
        ],
        # Split DWARF (see split_debug_mode below): the debug info stays in
        # the objects, and links neither copy it nor carry it. Not for the
        # triples without it, which build under the host's os.
        "config//os:linux": shims.select({
            "toolchains//cfg/target:target[wasm32-unknown-unknown]": [
                "-g",
                "-Og",
            ],
            "toolchains//cfg/target:target[x86_64-unknown-uefi]": [
                "-g",
                "-Og",
            ],
            "toolchains//cfg/target:target[aarch64-unknown-uefi]": [
                "-g",
                "-Og",
            ],
            "DEFAULT": shims.select({
                "toolchains//cfg/instrumentation:instrumentation[none]": [
                    "-g",
                    "-gsplit-dwarf=single",
                    "-Og",
                ],
                "DEFAULT": [
                    "-g",
                    "-Og",
                ],
            }),
        }),
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
] + shims.select({
    # libstdc++'s cheap assertions check container preconditions that ASan
    # cannot see, such as an index past a vector's size but within its
    # capacity. Unlike _GLIBCXX_DEBUG they leave the ABI alone, so prebuilt
    # C++ code still links.
    "config//os:linux": ["-D_GLIBCXX_ASSERTIONS"],
    "DEFAULT": [],
})

fozzie_asan_compiler_flags = fozzie_compiler_flags + [
    # UBSan adds the checks ASan lacks, such as signed overflow, bad shifts
    # and misaligned pointers. Its handlers live in the ASan runtime, and a
    # report aborts the run instead of letting it continue.
    "-fsanitize=address,undefined",
    "-fno-sanitize-recover=undefined",
    # Nix's clang wrapper passes -fwrapv for its strictoverflow hardening,
    # which defines signed overflow and so drops UBSan's check for it.
    "-fno-wrapv",
]

instrumentation_compiler_flags = shims.select({
    "toolchains//cfg/instrumentation:instrumentation[none]": [],
    "toolchains//cfg/instrumentation:instrumentation[fozzie]": fozzie_compiler_flags,
    "toolchains//cfg/instrumentation:instrumentation[fozzie-asan]": fozzie_asan_compiler_flags,
})

compiler_type = shims.select({
    "config//os:windows": "windows",
    "DEFAULT": "clang",
})

linker = shims.select({
    "toolchains//cfg/target:target[x86_64-unknown-uefi]": "lld",
    "toolchains//cfg/target:target[aarch64-unknown-uefi]": "lld",
    "toolchains//cfg/target:target[wasm32-unknown-unknown]": "lld",
    "DEFAULT": shims.select({
        "config//os:windows": "link.exe",
        "config//os:macos": "clang++",
        "DEFAULT": "clang++",
    }),
})

# The toolchain otherwise derives the linker type from config//os, which the
# wasm32 transition leaves at the host's, so on macOS a wasm link was treated
# as a Darwin one and given ld64 flags such as -oso_prefix. Naming the type
# also gives the outputs their .wasm suffix and lld's own spelling of
# --whole-archive.
linker_type = shims.select({
    "toolchains//cfg/target:target[wasm32-unknown-unknown]": "wasm",
    "DEFAULT": None,
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
    "toolchains//cfg/instrumentation:instrumentation[fozzie-asan]": [
        "-fuse-ld=lld",
        "-fsanitize=address",
        "-static-libsan",
        # Rust passes -nodefaultlibs, which suppresses -static-libstdc++.
        # Clang's ASan C++ runtime still needs the C++ ABI and RTTI symbols.
        "-Wl,--push-state,-Bstatic",
        "-lstdc++",
        "-Wl,--pop-state",
    ],
})

link_flags = shims.select({
    "toolchains//cfg/target:target[x86_64-unknown-uefi]": [],
    "toolchains//cfg/target:target[aarch64-unknown-uefi]": [],
    "toolchains//cfg/target:target[wasm32-unknown-unknown]": [],
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
        # Darwin ships ASan only as a dylib, which the clang driver adds at
        # link time. ld64 keeps the SanitizerCoverage sections Fozzie reads
        # without help, so the coverage-only profile needs nothing here.
        "config//os:macos": shims.select({
            "toolchains//cfg/instrumentation:instrumentation[fozzie-asan]": ["-fsanitize=address"],
            "DEFAULT": [],
        }),
        # An os with no triple above it is reachable: a transition may move
        # config//os without moving the target triple, which is what a
        # cross-compiled binary built on a host whose default triple names
        # another os looks like. Claiming no flags is the only safe answer,
        # since the flags those triples want are the ones we do not have.
        "DEFAULT": [],
    }),
})

# Debug builds on Linux keep debug info out of what they link: C and C++
# objects hold theirs (-gsplit-dwarf=single, in opt_flags above), and the
# prelude has rustc write each crate's into .dwo files beside it
# (-Csplit-debuginfo=unpacked). Linking copies none of it, so links are
# faster and binaries a fraction of the size, and debuggers read it from
# where it was compiled; a binary's [dwp] sub-target packs it all into one
# .dwp file to take elsewhere. Release builds keep their line tables in the
# binary, for backtraces, and so do fuzzing builds, whose crash reports
# symbolize from the binary alone.
split_debug_mode = shims.select({
    "mode//:build-mode[debug]": shims.select({
        "config//os:linux": shims.select({
            "toolchains//cfg/instrumentation:instrumentation[none]": shims.select({
                "toolchains//cfg/target:target[wasm32-unknown-unknown]": None,
                "toolchains//cfg/target:target[x86_64-unknown-uefi]": None,
                "toolchains//cfg/target:target[aarch64-unknown-uefi]": None,
                "DEFAULT": "single",
            }),
            "DEFAULT": None,
        }),
        "DEFAULT": None,
    }),
    "DEFAULT": None,
})

system_cxx_toolchain(
    name = "cxx",
    # GNU ar cannot build the symbol index for WebAssembly object files.
    archiver = shims.select({
        "toolchains//cfg/target:target[wasm32-unknown-unknown]": "llvm-ar",
        "DEFAULT": None,
    }),
    c_flags = cxx_warn_flags + opt_flags + instrumentation_compiler_flags,
    compiler_type = compiler_type,
    compiler_wrapper = shims.select({
        "toolchains//cfg/target:target[wasm32-unknown-unknown]": "wasm-compiler.sh",
        "DEFAULT": None,
    }),
    cxx_flags = cxx_base_flags + cxx_warn_flags + opt_flags + instrumentation_compiler_flags,
    dwp = shims.select({
        "config//os:linux": "llvm-dwp",
        "DEFAULT": None,
    }),
    link_flags = link_flags,
    linker = linker,
    linker_type = linker_type,
    split_debug_mode = split_debug_mode,
)

# Read by the toolchain rule, which the shims do not wrap.
shims.lint_files(
    name = "scripts",
    srcs = ["wasm-compiler.sh"],
)

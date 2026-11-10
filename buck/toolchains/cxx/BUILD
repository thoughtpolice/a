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
        # /EHsc: C++ exceptions, which cl.exe and clang-cl leave off unless
        # asked, and every other compiler here has on (CMake's default too).
        "config//os:windows": [
            "/std:c++17",
            "/EHsc",
            "/Zc:__cplusplus",
            "/Zc:inline",
            "/Zc:wchar_t",
            "/Zc:forScope",
            "/fp:precise",
        ],
    }),
})

# clang-cl on Windows: the target's triple, and the dynamic release CRT
# (/MD), which is the one rustc links on every *-windows-msvc target in debug
# builds as in release ones; objects built for another CRT would not link
# beside Rust's.
windows_flags = shims.select({
    "toolchains//cfg/target:target[x86_64-pc-windows-msvc]": ["--target=x86_64-pc-windows-msvc"],
    "toolchains//cfg/target:target[aarch64-pc-windows-msvc]": ["--target=aarch64-pc-windows-msvc"],
    "DEFAULT": [],
}) + [
    "/MD",
    # Flags of cl.exe's that clang-cl takes and ignores (/d2threads1, which
    # the prelude passes for "windows" compilers), and says so of each time.
    "-Wno-unused-command-line-argument",
]

opt_flags = shims.select({
    "mode//:build-mode[debug]": shims.select({
        # /Z7 keeps CodeView in each object rather than a shared PDB, which
        # concurrent compiles would contend for.
        "config//os:windows": [
            "/Z7",
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

# clang-cl is driven as cl.exe is ("windows"), not as "clang_cl": in cl
# mode clang ends an option at the end of a response file's line, and the
# prelude writes "clang_cl" flags that take a separate argument (-I DIR,
# -Xclang -fdebug-compilation-dir -Xclang DIR) on two lines of its argsfiles,
# which clang-cl then reads as an option missing its argument. cl.exe's
# spellings (/IDIR, /external:IDIR, /Brepro) are clang-cl's too.
compiler_type = shims.select({
    "config//os:windows": "windows",
    "DEFAULT": "clang",
})

# clang-cl reads -MD as /MD, the CRT, so it reports headers with
# /showIncludes rather than writing a makefile.
cpp_dep_tracking_mode = shims.select({
    "config//os:windows": "show_includes",
    "DEFAULT": "makefile",
})

linker = shims.select({
    "toolchains//cfg/target:target[x86_64-unknown-uefi]": "lld",
    "toolchains//cfg/target:target[aarch64-unknown-uefi]": "lld",
    "toolchains//cfg/target:target[wasm32-unknown-unknown]": "lld",
    "DEFAULT": shims.select({
        "config//os:windows": "lld-link",
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
        # lld-link, which finds the MSVC and Windows SDK libraries itself.
        "config//os:windows": shims.select({
            "toolchains//cfg/target:target[x86_64-pc-windows-msvc]": ["/machine:x64"],
            "toolchains//cfg/target:target[aarch64-pc-windows-msvc]": ["/machine:arm64"],
            "DEFAULT": [],
        }) + shims.select({
            "mode//:build-mode[debug]": ["/debug"],
            "DEFAULT": [],
        }) + [
            # What Rust's standard library links on *-windows-msvc (rustc
            # --print native-static-libs), which a link lld-link makes rather
            # than rustc has to name itself: a Rust staticlib's, say.
            "kernel32.lib",
            "ntdll.lib",
            "userenv.lib",
            "ws2_32.lib",
            "dbghelp.lib",
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
    # clang-cl assembling .S sources (on Windows, arm64's): the target, which
    # it otherwise takes to be the host's.
    as_flags = shims.select({
        "toolchains//cfg/target:target[x86_64-pc-windows-msvc]": ["--target=x86_64-pc-windows-msvc"],
        "toolchains//cfg/target:target[aarch64-pc-windows-msvc]": ["--target=aarch64-pc-windows-msvc"],
        "DEFAULT": [],
    }),
    # llvm-ml, MASM's stand-in, assembles for 32-bit x86 unless told
    # otherwise. It has no armasm64 mode: arm64 assembly is GNU syntax (.S).
    asm_flags = shims.select({
        "toolchains//cfg/target:target[x86_64-pc-windows-msvc]": ["-m64"],
        "DEFAULT": [],
    }),
    c_flags = cxx_warn_flags + opt_flags + instrumentation_compiler_flags + shims.select({
        "config//os:windows": windows_flags,
        "DEFAULT": [],
    }),
    compiler_type = compiler_type,
    compiler_wrapper = shims.select({
        "toolchains//cfg/target:target[wasm32-unknown-unknown]": "wasm-compiler.sh",
        "DEFAULT": None,
    }),
    cpp_dep_tracking_mode = cpp_dep_tracking_mode,
    cxx_flags = cxx_base_flags + cxx_warn_flags + opt_flags + instrumentation_compiler_flags + shims.select({
        "config//os:windows": windows_flags,
        "DEFAULT": [],
    }),
    dwp = shims.select({
        "config//os:linux": "llvm-dwp",
        "DEFAULT": None,
    }),
    link_flags = link_flags,
    linker = linker,
    linker_type = linker_type,
    split_debug_mode = split_debug_mode,
)

# llvm-ml, with the response files it does not read itself expanded
# (windows_clang_tools).
shims.python_bootstrap_binary(
    name = "ml",
    main = "ml.py",
    visibility = ["toolchains//cxx/..."],
)

# Read by the toolchain rule, which the shims do not wrap.
shims.lint_files(
    name = "scripts",
    srcs = ["wasm-compiler.sh"],
)

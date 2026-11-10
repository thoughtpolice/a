# SPDX-FileCopyrightText: © 2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

# Chez Scheme, built without its configure script or Zuo build: the
# configuration upstream's configure would choose for each supported
# platform is recorded below, and defs.bzl does what s/build.zuo does.
#
# The build bootstraps the way upstream's does from a release tarball:
#
#   1. :pb-scheme, a kernel for the portable bytecode machine type `pb`,
#      runs the bytecode boot files the tarball ships;
#   2. that compiles Chez Scheme's sources into the boot files for the
#      target's machine type, and generates the C headers for its kernel
#      (:boot, :boot-headers);
#   3. the target's kernel is compiled against those headers (:kernel), and
#      installed with the boot files (:install).
#
# :test-fixpoint checks that the compiler in those boot files, run natively,
# compiles itself into the same boot files.
#
# Every step runs a C compiler or Chez Scheme itself, never a shell, so the
# build is the same on Linux, macOS and Windows.

load("@root//buck/shims:package.bzl", "pkg")
load("@root//buck/shims:shims.bzl", "shims")
load(":defs.bzl", "HEADERS", "chez_boot_files", "chez_install")

VERSION = pkg.version()

ZLIB = "third-party//by-name/zl/zlib:libz"

LZ4 = "third-party//by-name/lz/lz4:lz4"

# The kernel's sources, apart from the one for the CPU. Upstream's
# `kernel-src-files`.
KERNEL_SRCS = [
    "alloc.c",
    "compress-io.c",
    "expeditor.c",
    "fasl.c",
    "ffi.c",
    "flushcache.c",
    "foreign.c",
    "gc-011.c",
    "gc-ocd.c",
    "gc-oce.c",
    "gc-par.c",
    "gcwrapper.c",
    "intern.c",
    "io.c",
    "new-io.c",
    "number.c",
    "prim.c",
    "prim5.c",
    "print.c",
    "random.c",
    "scheme.c",
    "schlib.c",
    "schsig.c",
    "segment.c",
    "self-exe.c",
    "stats.c",
    "statics.c",
    "symbol.c",
    "thread.c",
    "vfasl.c",
]

# Including gc.c and itest.c, which other sources #include.
KERNEL_HEADERS = [
    "atomic.h",
    "compress-io.h",
    "externs.h",
    "gc.c",
    "globals.h",
    "itest.c",
    "nocurses.h",
    "pb.h",
    "segment.h",
    "sort.h",
    "system.h",
    "thread.h",
    "types.h",
    "version.h",
]

# The CPU-specific sources, and on Windows the system's, which take the
# place of the CPU's (upstream's `or-windows` and `add-windows`), and the
# assembly for setjmp and longjmp there.
ARCH_SRCS = [
    "a6nt-jump.asm",
    "arm64nt-jump.S",
    "clearcache.c",
    "i3le.c",
    "pb.c",
    "windows.c",
]

shims.http_archive(
    name = "src",
    sha256 = "2e74952db7bc177f0c3602e2217a341ba677d733eec4cd7726418c3a4e1ef308",
    strip_prefix = "csv{}".format(VERSION),
    # The release tarball, unlike a checkout, carries the submodules
    # (Nanopass among them) and the boot files for `pb`.
    sub_targets = [
        "c/" + f
        for f in KERNEL_SRCS + KERNEL_HEADERS + ARCH_SRCS + ["main.c"]
    ] + ["boot/pb/" + h for h in HEADERS],
    type = "tar.gz",
    urls = [
        "https://github.com/cisco/ChezScheme/releases/download/v{v}/csv{v}.tar.gz".format(v = VERSION),
    ],
)

# MARK: Configuration

# The machine type of the target: threaded, for the CPU and OS.
MACHINE = shims.select({
    "config//os:linux": shims.select({
        "config//cpu:arm64": "tarm64le",
        "config//cpu:x86_64": "ta6le",
    }),
    "config//os:macos": shims.select({
        "config//cpu:arm64": "tarm64osx",
        "config//cpu:x86_64": "ta6osx",
    }),
    "config//os:windows": shims.select({
        "config//cpu:arm64": "tarm64nt",
        "config//cpu:x86_64": "ta6nt",
    }),
})

# The architecture in MACHINE, as Chez Scheme names it.
ARCH = shims.select({
    "config//cpu:arm64": "arm64",
    "config//cpu:x86_64": "a6",
})

# What configure records for these platforms, with no curses (there are no
# ncurses headers to build the expression editor with) and no X11 (whose
# headers its clipboard support needs). The boot files are found relative to
# the executable, in ../lib/csv<version>/<machine>, as installed (:install),
# or beside it. Upstream's Windows build writes no search path, and the
# kernel's default there is the executable's directory and ..\..\boot\<machine>
# of a build tree; this one adds the installed layout, in the kernel's own
# spelling, with `;` between directories.
shims.write_file(
    name = "config.h",
    contents = [
        "#define DISABLE_CURSES",
        "#define DISABLE_X11",
    ] + shims.select({
        "config//os:windows": [
            '#define DEFAULT_HEAP_PATH "%x;%x\\\\..\\\\lib\\\\csv%v\\\\%m;%x\\\\..\\\\..\\\\boot\\\\%m"',
        ],
        "DEFAULT": [
            '#define DEFAULT_HEAP_PATH "%x:%x/../lib/csv%v/%m:%x/../../boot/%m"',
        ],
    }) + [
        "",
    ],
)

# configure's CFLAGS, which take the place of the toolchain's optimization
# level (the collector is slow at -Og), and its default warnings. On
# Windows, upstream's for MSVC, which clang-cl takes too: the kernel keys on
# WIN32, which only MSVC's headers define (clang-cl defines _WIN32), and
# /W3 since clang-cl reads -Wall as -Weverything.
CFLAGS = shims.select({
    "config//os:windows": [
        "-O2",
        "/W3",
        "/DWIN32",
        "/D_CRT_SECURE_NO_WARNINGS",
    ],
    "DEFAULT": [
        "-O2",
        "-Wpointer-arith",
        "-Wall",
        "-Wextra",
        "-Wno-implicit-fallthrough",
    ],
}) + shims.select({
    "config//os:linux": [
        "-D_REENTRANT",
        "-pthread",
    ] + shims.select({
        "config//cpu:arm64": [],
        "config//cpu:x86_64": ["-msse2"],
    }),
    "config//os:macos": [],
    "config//os:windows": [],
})

# configure's LDFLAGS and LIBS. The executable exports the kernel's symbols,
# for shared objects that load-shared-object loads to call back into. On
# Windows, the kernel's own declarations do that (scheme.h marks them
# __declspec(dllexport) unless SCHEME_STATIC is defined, which it is not),
# and the libraries are upstream's, with the C stack upstream gives its
# executable, which a program running Chez Scheme needs as much.
LINKER_FLAGS = shims.select({
    "config//os:linux": [
        "-rdynamic",
        "-lm",
        "-ldl",
        "-lrt",
        "-lpthread",
    ],
    "config//os:macos": [
        "-liconv",
        "-lm",
    ],
    "config//os:windows": [
        "advapi32.lib",
        "ole32.lib",
        "rpcrt4.lib",
        "shell32.lib",
        "user32.lib",
        "uuid.lib",
        "/STACK:16777216",
    ],
})

# MARK: Bootstrap

# The kernel for `pb`, which runs on the build machine, and only for the
# bootstrap.
shims.cxx_library(
    name = "pb-kernel",
    srcs = [":src[c/{}]".format(f) for f in KERNEL_SRCS + ["pb.c"]] + shims.select({
        "config//os:windows": [":src[c/windows.c]"],
        "DEFAULT": [],
    }),
    compiler_flags = CFLAGS,
    exported_deps = [
        LZ4,
        ZLIB,
    ],
    exported_headers = {
        "scheme.h": ":src[boot/pb/scheme.h]",
    },
    exported_linker_flags = LINKER_FLAGS,
    # Which the native machine types' scheme.h defines, and pb's can't: it
    # declares the Windows API (Sgetenv, Swide_to_utf8) for main.c too.
    exported_preprocessor_flags = shims.select({
        "config//os:windows": ["-DFEATURE_WINDOWS"],
        "DEFAULT": [],
    }),
    header_namespace = "",
    headers = {h: ":src[c/{}]".format(h) for h in KERNEL_HEADERS} | {
        h: ":src[boot/pb/{}]".format(h)
        for h in HEADERS
        if h != "scheme.h"
    } | {
        "config.h": ":config.h",
    },
    preferred_linkage = "static",
    preprocessor_flags = ["-DPORTABLE_BYTECODE"],
    visibility = [],
)

shims.cxx_binary(
    name = "pb-scheme",
    srcs = [":src[c/main.c]"],
    compiler_flags = CFLAGS,
    header_namespace = "",
    headers = {
        "config.h": ":config.h",
    },
    visibility = [],
    deps = [":pb-kernel"],
)

chez_boot_files(
    name = "boot",
    src = ":src",
    arch = ARCH,
    cross = True,
    # The boot files' paths start with `.`: Chez Scheme looks for a boot
    # file named any other way (but absolutely) in its search path.
    host = [
        "$(exe :pb-scheme)",
        "-b",
        "./$(location :src)/boot/pb/petite.boot",
        "-b",
        "./$(location :src)/boot/pb/scheme.boot",
    ],
    machine = MACHINE,
)

# MARK: Runtime

# The runtime, for a C program that embeds Chez Scheme: scheme.h and the
# kernel. The program loads petite.boot or scheme.boot (`:install[lib]`)
# with Sregister_boot_file.
# setjmp and longjmp for Windows (version.h's HAND_CODED_SETJMP_SIZE), which
# Chez Scheme's stack frames need: the C runtime's longjmp unwinds the stack
# for C++, and they don't have what that takes. MASM on x86_64 (llvm-ml);
# arm64's is GNU syntax, which the C compiler assembles.
shims.cxx_library(
    name = "jump",
    srcs = shims.select({
        "config//cpu:arm64": [":src[c/arm64nt-jump.S]"],
        "config//cpu:x86_64": [":src[c/a6nt-jump.asm]"],
    }),
    preferred_linkage = "static",
    target_compatible_with = ["config//os:windows"],
    visibility = [],
)

shims.cxx_library(
    name = "kernel",
    srcs = [":src[c/{}]".format(f) for f in KERNEL_SRCS] + shims.select({
        "config//os:windows": [":src[c/windows.c]"],
        "DEFAULT": shims.select({
            "config//cpu:arm64": [":src[c/clearcache.c]"],
            "config//cpu:x86_64": [":src[c/i3le.c]"],
        }),
    }),
    compiler_flags = CFLAGS,
    exported_deps = [
        LZ4,
        ZLIB,
    ] + shims.select({
        "config//os:windows": [":jump"],
        "DEFAULT": [],
    }),
    exported_headers = {
        "scheme.h": ":boot-headers[scheme.h]",
    },
    exported_linker_flags = LINKER_FLAGS,
    header_namespace = "",
    headers = {h: ":src[c/{}]".format(h) for h in KERNEL_HEADERS} | {
        h: ":boot-headers[{}]".format(h)
        for h in HEADERS
        if h != "scheme.h"
    } | {
        "config.h": ":config.h",
    },
    preferred_linkage = "static",
    preprocessor_flags = shims.select({
        "config//cpu:arm64": ["-DAARCH64"],
        "config//cpu:x86_64": ["-DX86_64"],
    }),
    visibility = ["PUBLIC"],
)

shims.cxx_binary(
    name = "scheme-exe",
    srcs = [":src[c/main.c]"],
    compiler_flags = CFLAGS,
    header_namespace = "",
    headers = {
        "config.h": ":config.h",
    },
    visibility = [],
    deps = [":kernel"],
)

chez_install(
    name = "install",
    machine = MACHINE,
    petite_boot = ":boot[petite.boot]",
    scheme = ":scheme-exe",
    scheme_boot = ":boot[scheme.boot]",
    scheme_h = ":boot-headers[scheme.h]",
    version = VERSION,
)

[
    shims.command(
        name = name,
        cmd = ["$(location :install[{}])".format(name)],
        visibility = ["PUBLIC"],
    )
    for name in [
        "scheme",
        "petite",
        "scheme-script",
    ]
]

# MARK: Tests

# The installed tools from the outside: the version, the machine type and
# its threads, the compiler (which petite lacks), and a script.
shims.export_file(
    name = "test-install.ss",
    visibility = [],
)

shims.export_file(
    name = "sum.ss",
    visibility = [],
)

shims.command_test(
    name = "test-install",
    cmd = [
        "$(location :install[scheme])",
        "-q",
        "--script",
        "$(location :test-install.ss)",
        VERSION,
        MACHINE,
        "$(location :install[scheme])",
        "$(location :install[petite])",
        "$(location :install[scheme-script])",
        "$(location :sum.ss)",
    ],
)

# Upstream's `bootstrap` rebuilds the boot files with the system they built
# until that changes nothing. The boot files from `pb` should already be
# that fixpoint: the same compiler, run natively, makes the same files.
chez_boot_files(
    name = "rebuild",
    src = ":src",
    arch = ARCH,
    cross = False,
    host = ["$(location :install[scheme])"],
    machine = MACHINE,
)

shims.export_file(
    name = "test-fixpoint.ss",
    visibility = [],
)

shims.command_test(
    name = "test-fixpoint",
    cmd = [
        "$(location :install[scheme])",
        "-q",
        "--script",
        "$(location :test-fixpoint.ss)",
    ] + [
        "$(location :{}[{}])".format(target, f)
        for f in [
            "petite.boot",
            "scheme.boot",
        ]
        for target in [
            "boot",
            "rebuild",
        ]
    ] + [
        "$(location :{}[{}])".format(target, h)
        for h in HEADERS
        for target in [
            "boot-headers",
            "rebuild-headers",
        ]
    ],
)

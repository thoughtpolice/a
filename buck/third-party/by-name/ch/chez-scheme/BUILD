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

load("@root//buck/shims:package.bzl", "pkg")
load("@root//buck/shims:shims.bzl", "shims")
load(":defs.bzl", "HEADERS", "chez_boot_files")

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

# The CPU-specific sources.
ARCH_SRCS = [
    "clearcache.c",
    "i3le.c",
    "pb.c",
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
})

# What configure records for these platforms, with no curses (there are no
# ncurses headers to build the expression editor with) and no X11 (whose
# headers its clipboard support needs). The boot files are found relative to
# the executable, in ../lib/csv<version>/<machine>.
shims.write_file(
    name = "config.h",
    contents = [
        "#define DISABLE_CURSES",
        "#define DISABLE_X11",
        '#define DEFAULT_HEAP_PATH "%x:%x/../lib/csv%v/%m:%x/../../boot/%m"',
        "",
    ],
)

# configure's CFLAGS, which take the place of the toolchain's optimization
# level (the collector is slow at -Og), and its default warnings.
CFLAGS = [
    "-O2",
    "-Wpointer-arith",
    "-Wall",
    "-Wextra",
    "-Wno-implicit-fallthrough",
] + shims.select({
    "config//os:linux": [
        "-D_REENTRANT",
        "-pthread",
    ] + shims.select({
        "config//cpu:arm64": [],
        "config//cpu:x86_64": ["-msse2"],
    }),
    "config//os:macos": [],
})

# configure's LDFLAGS and LIBS. The executable exports the kernel's symbols,
# for shared objects that load-shared-object loads to call back into.
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
})

# MARK: Bootstrap

# The kernel for `pb`, which runs on the build machine, and only for the
# bootstrap.
shims.cxx_library(
    name = "pb-kernel",
    srcs = [":src[c/{}]".format(f) for f in KERNEL_SRCS + ["pb.c"]],
    compiler_flags = CFLAGS,
    exported_deps = [
        LZ4,
        ZLIB,
    ],
    exported_headers = {
        "scheme.h": ":src[boot/pb/scheme.h]",
    },
    exported_linker_flags = LINKER_FLAGS,
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
    cross = True,
    host = " ".join([
        "$(exe :pb-scheme)",
        "-b $root/$(location :src)/boot/pb/petite.boot",
        "-b $root/$(location :src)/boot/pb/scheme.boot",
    ]),
    machine = MACHINE,
)

# MARK: Runtime

# The runtime, for a C program that embeds Chez Scheme: scheme.h and the
# kernel. The program loads petite.boot or scheme.boot (`:install[lib]`)
# with Sregister_boot_file.
shims.cxx_library(
    name = "kernel",
    srcs = [":src[c/{}]".format(f) for f in KERNEL_SRCS] + shims.select({
        "config//cpu:arm64": [":src[c/clearcache.c]"],
        "config//cpu:x86_64": [":src[c/i3le.c]"],
    }),
    compiler_flags = CFLAGS,
    exported_deps = [
        LZ4,
        ZLIB,
    ],
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

# The installed files dependents use, by name; `{lib}` is the machine's
# library directory.
INSTALL_OUTS = {
    "bin": "bin",
    "lib": "{lib}",
    "petite": "bin/petite",
    "petite.boot": "{lib}/petite.boot",
    "scheme": "bin/scheme",
    "scheme-script": "bin/scheme-script",
    "scheme.boot": "{lib}/scheme.boot",
    "scheme.h": "{lib}/scheme.h",
}

# Upstream's install layout. The executable picks its boot file from the
# name it was run as, so `petite` and `scheme-script` are copies of it, and
# scheme-script.boot of scheme.boot.
shims.genrule(
    name = "install",
    outs = shims.select({
        os: shims.select({
            cpu: {
                name: [path.format(lib = "lib/csv{}/{}".format(VERSION, machine))]
                for name, path in INSTALL_OUTS.items()
            }
            for cpu, machine in machines.items()
        })
        for os, machines in {
            "config//os:linux": {
                "config//cpu:arm64": "tarm64le",
                "config//cpu:x86_64": "ta6le",
            },
            "config//os:macos": {
                "config//cpu:arm64": "tarm64osx",
                "config//cpu:x86_64": "ta6osx",
            },
        }.items()
    }),
    cmd = """
        set -eu
        lib=$OUT/lib/csv{version}/$MACHINE
        mkdir -p $OUT/bin $lib
        for exe in scheme petite scheme-script; do
            cp $(location :scheme-exe) $OUT/bin/$exe
        done
        cp $(location :boot[petite.boot]) $(location :boot[scheme.boot]) $lib
        cp $(location :boot[scheme.boot]) $lib/scheme-script.boot
        cp $(location :boot-headers[scheme.h]) $lib
    """.format(version = VERSION),
    env = {
        "MACHINE": MACHINE,
    },
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
shims.command_test(
    name = "test-install",
    script = "machine=" + MACHINE + """
        scheme=$(location :install[scheme])
        petite=$(location :install[petite])
        script=$(location :install[scheme-script])

        test "`$scheme --version 2>&1`" = "{version}"
        test "`echo '(machine-type)' | $scheme -q`" = "$machine"
        test "`echo '(threaded?)' | $scheme -q`" = "#t"
        test "`echo '(petite?)' | $petite -q`" = "#t"
        echo "(compile '(+ 1 2))" | $scheme -q | grep -qx 3

        dir=`mktemp -d`
        trap 'rm -rf "$dir"' EXIT
        printf '%s\\n' '(import (chezscheme))' \\
            '(printf "~a\\n" (apply + (map string->number (command-line-arguments))))' \\
            > "$dir/sum.ss"
        test "`$script $dir/sum.ss 1 2 3`" = 6
    """.format(version = VERSION),
)

# Upstream's `bootstrap` rebuilds the boot files with the system they built
# until that changes nothing. The boot files from `pb` should already be
# that fixpoint: the same compiler, run natively, makes the same files.
chez_boot_files(
    name = "rebuild",
    cross = False,
    host = "$(location :install[scheme])",
    machine = MACHINE,
)

shims.command_test(
    name = "test-fixpoint",
    script = """
        export BOOT=$(location :boot) REBUILD=$(location :rebuild)
        echo '
            (reset-handler abort)
            (for-each
              (lambda (boot)
                (#%$fasl-file-equal?
                  (format "~a/~a" (getenv "BOOT") boot)
                  (format "~a/~a" (getenv "REBUILD") boot)
                  #t))
              (list "petite.boot" "scheme.boot"))
        ' | $(location :install[scheme]) -q
    """ + "\n".join([
        "cmp $(location :boot-headers[{h}]) $(location :rebuild-headers[{h}])".format(h = h)
        for h in HEADERS
    ]),
)

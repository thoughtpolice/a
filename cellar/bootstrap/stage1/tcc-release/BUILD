# SPDX-FileCopyrightText: © 2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

load("@cellar//bootstrap:actions.bzl", "command_test", "generate")
load("@cellar//bootstrap:defs.bzl", "export_file", "filegroup")
load("@cellar//bootstrap:source.bzl", "download_file", "exact_patch", "untar", "write_file")
load("@cellar//bootstrap/stage1:defs.bzl", "c_binary", "c_library", "c_object", "link_runtime", "sysroot")
load("@cellar//bootstrap/stage1/tcc:defs.bzl", "tcc_toolchain")
load("@cellar//bootstrap/stage1/tcc:sources.bzl", "LIBC_SOURCES")
load(":defs.bzl", "release_defines", "release_libtcc1", "release_tcc", "release_test_objects", "release_test_programs")
load(":sources.bzl", "TCC_FILES")

download_file(
    name = "tcc-0.9.27.tar.bz2",
    hash = "de23af78fca90ce32dff2dd45b3432b2334740bb9bb7b05bf60fdbfc396ceb9c",
    urls = ["https://www.mirrorservice.org/sites/download.savannah.gnu.org/releases/tinycc/tcc-0.9.27.tar.bz2"],
)

generate(
    name = "tcc.tar",
    args = [
        "--file",
        "$(location :tcc-0.9.27.tar.bz2)",
    ],
    output = "tcc.tar",
    output_flags = ["--output"],
    tool = "cellar//bootstrap/stage0-posix/mescc-tools-extra:unbz2",
)

untar(
    name = "tcc-0.9.27",
    files = TCC_FILES,
    input = ":tcc.tar",
    untar = "cellar//bootstrap/stage0-posix/mescc-tools-extra:untar",
)

write_file(
    name = "config.h",
    content = "/* Configuration is declared in BUILD. */\n",
)

# Architecture-independent reference fixes, plus direct static x86_64 calls.
[
    exact_patch(
        name = name,
        src = src,
        output = output,
        patch = ":patches/" + patch + ".patch",
    )
    for name, src, patch, output in [
        ("tcctools-remove", ":tcc-0.9.27[tcctools.c]", "remove-fileopen", "tcctools.c"),
        ("tcctools-open", ":tcctools-remove", "addback-fileopen", "tcctools.c"),
        ("tcctools-index", ":tcctools-open", "weak-index", "tcctools.c"),
        ("tcctools", ":tcctools-index", "empty-archive", "tcctools.c"),
        ("x86_64-asm", ":tcc-0.9.27[x86_64-asm.h]", "mxcsr", "x86_64-asm.h"),
        ("libtcc", ":tcc-0.9.27[libtcc.c]", "static-default", "libtcc.c"),
        ("tccelf-got", ":tcc-0.9.27[tccelf.c]", "check-reloc-null", "tccelf.c"),
        ("tccelf-static", ":tccelf-got", "static-calls", "tccelf.c"),
        ("tccelf-tidy", ":tccelf-static", "got-before-tidy", "tccelf.c"),
        ("tccelf", ":tccelf-tidy", "runtime-rescan", "tccelf.c"),
        ("tccgen", ":tcc-0.9.27[tccgen.c]", "array-quals", "tccgen.c"),
    ]
]

[export_file(name = path) for path in glob([
    "patches/*.patch",
    "tests/*",
])]

filegroup(
    name = "source",
    srcs = {path: ":tcc-0.9.27[{}]".format(path) for path in TCC_FILES} | {
        "config.h": ":config.h",
        "x86_64-asm.h": ":x86_64-asm",
        "tcctools.c": ":tcctools",
        "libtcc.c": ":libtcc",
        "tccelf.c": ":tccelf",
        "tccgen.c": ":tccgen",
    },
)

BOOT = "cellar//bootstrap/stage1/tcc"

MES = "cellar//bootstrap/mes"

# mes0: the TCC 0.9.26 fixed point compiles the release, which links against
# the 0.9.26 Mes runtime.
release_tcc(
    name = "mes0",
    defines = release_defines("/mes/loader"),
    flags = ["-nostdinc"],
    headers = [
        ":source",
        BOOT + ":headers",
    ],
    includes = [
        ":source",
        BOOT + ":headers",
    ],
    link_flags = [
        "-nostdlib",
        "-static",
    ],
    runtime = BOOT + ":boot2-link-runtime",
    toolchain = BOOT + ":tcc",
)

tcc_toolchain(
    name = "mes0-compiler",
    cflags = [
        "-nostdinc",
        "-D__SIZEOF_LONG_LONG__=8",
        "-I",
        "$(location " + BOOT + ":headers)",
    ],
    execution_runtime = BOOT + ":runtime-boot2",
    sysroot = BOOT + ":runtime-boot2",
    tcc = ":tcc-mes0",
)

command_test(
    name = "mes0-version",
    args = ["-version"],
    tool = ":tcc-mes0",
)

release_test_objects(
    name = "mes0",
    toolchain = ":mes0-compiler",
)

release_test_programs(
    name = "mes0",
    objects = "mes0",
    runtime = BOOT + ":boot2-link-runtime",
    toolchain = ":mes0-compiler",
)

# The release compiler then rebuilds the Mes runtime: Mes libc, the CRT
# objects, getopt and its own support library.
exact_patch(
    name = "abtol.c",
    src = MES + ":mes-src[lib/mes/abtol.c]",
    output = "abtol.c",
    patch = ":patches/abtol.patch",
)

[
    c_object(
        name = "mes0-libc-{}.o".format(i),
        src = {
            "lib/mes/__buffered_read.c": BOOT + ":buffered-read.c",
            "lib/mes/abtod.c": BOOT + ":abtod.c",
            "lib/mes/abtol.c": ":abtol.c",
            "lib/stub/ldexp.c": BOOT + ":runtime-source[runtime/ldexp.c]",
        }.get(
            path,
            MES + ":mes-src[{}]".format(path),
        ),
        defines = ["HAVE_CONFIG_H=1"],
        headers = [BOOT + ":headers"],
        includes = [
            BOOT + ":headers",
            BOOT + ":headers[linux/x86_64]",
        ],
        object_name = "r{}.o".format(i),
        toolchain = ":mes0-compiler",
    )
    for i, path in enumerate(LIBC_SOURCES)
]

[
    c_object(
        name = "mes0-" + name + ".o",
        src = src,
        defines = [
            "HAVE_CONFIG_H=1",
            "TCC_TARGET_X86_64=1",
        ],
        headers = [BOOT + ":headers"],
        includes = [
            BOOT + ":headers",
            BOOT + ":headers[linux/x86_64]",
        ],
        object_name = name + ".o",
        toolchain = ":mes0-compiler",
    )
    for name, src in [
        (
            "crt1",
            BOOT + ":runtime-source[runtime/crt1.S]",
        ),
        (
            "crti",
            BOOT + ":runtime-source[runtime/empty.S]",
        ),
        (
            "crtn",
            BOOT + ":runtime-source[runtime/empty.S]",
        ),
        (
            "setjmp",
            BOOT + ":runtime-source[runtime/setjmp.S]",
        ),
        (
            "exit",
            BOOT + ":runtime-source[runtime/exit.S]",
        ),
        ("support", ":source[lib/libtcc1.c]"),
        ("varargs", ":source[lib/va_list.c]"),
        ("alloca", ":source[lib/alloca86_64.S]"),
        (
            "getopt",
            MES + ":mes-src[lib/posix/getopt.c]",
        ),
    ]
]

c_library(
    name = "mes0-libc.a",
    objects = [":mes0-libc-{}.o".format(i) for i in range(len(LIBC_SOURCES))] + [
        ":mes0-setjmp.o",
        ":mes0-exit.o",
    ],
    output = "libc.a",
    toolchain = ":mes0-compiler",
)

c_library(
    name = "mes0-libtcc1.a",
    objects = [":mes0-" + name + ".o" for name in [
        "support",
        "varargs",
        "alloca",
    ]],
    output = "libtcc1.a",
    toolchain = ":mes0-compiler",
)

c_library(
    name = "mes0-libgetopt.a",
    objects = [":mes0-getopt.o"],
    output = "libgetopt.a",
    toolchain = ":mes0-compiler",
)

sysroot(
    name = "runtime-mes0",
    abi = "x86_64-sysv",
    files = {"include": BOOT + ":headers"},
    libraries = {"lib/" + name + ".a": ":mes0-" + name + ".a" for name in [
        "libc",
        "libgetopt",
        "libtcc1",
    ]},
    object_format = "elf64-x86-64",
    objects = {"lib/" + name + ".o": ":mes0-" + name + ".o" for name in [
        "crt1",
        "crti",
        "crtn",
    ]},
)

link_runtime(
    name = "mes0-link-runtime",
    libraries = [
        ":mes0-libc.a",
        ":mes0-libtcc1.a",
        ":mes0-libc.a",
    ],
    start_objects = [":mes0-crt1.o"],
)

release_test_programs(
    name = "rebuilt-mes",
    objects = "mes0",
    runtime = ":mes0-link-runtime",
    toolchain = ":mes0-compiler",
)

# mes1: TCC 0.9.26 compiles the release again, which now links against the
# rebuilt Mes runtime, and builds the release support library.
tcc_toolchain(
    name = "mes1-predecessor",
    cflags = [
        "-nostdinc",
        "-I",
        "$(location " + BOOT + ":headers)",
    ],
    execution_runtime = BOOT + ":runtime-boot1",
    sysroot = ":runtime-mes0",
    tcc = BOOT + ":tcc-boot2",
)

release_tcc(
    name = "mes1",
    defines = release_defines("/mes/loader"),
    headers = [
        ":source",
        BOOT + ":headers",
    ],
    includes = [":source"],
    runtime = ":mes0-link-runtime",
    toolchain = ":mes1-predecessor",
)

release_libtcc1(
    name = "mes1",
    toolchain = ":mes1-predecessor",
)

sysroot(
    name = "runtime-mes1",
    abi = "x86_64-sysv",
    files = {"include": BOOT + ":headers"},
    libraries = {
        "lib/libc.a": ":mes0-libc.a",
        "lib/libgetopt.a": ":mes0-libgetopt.a",
        "lib/libtcc1.a": ":mes1-libtcc1.a",
    },
    object_format = "elf64-x86-64",
    objects = {"lib/" + name + ".o": ":mes0-" + name + ".o" for name in [
        "crt1",
        "crti",
        "crtn",
    ]},
)

link_runtime(
    name = "mes1-link-runtime",
    libraries = [
        ":mes0-libc.a",
        ":mes1-libtcc1.a",
        ":mes0-libc.a",
    ],
    start_objects = [":mes0-crt1.o"],
)

tcc_toolchain(
    name = "mes1-compiler",
    cflags = [
        "-nostdinc",
        "-D__SIZEOF_LONG_LONG__=8",
        "-I",
        "$(location " + BOOT + ":headers)",
    ],
    execution_runtime = ":runtime-mes0",
    sysroot = ":runtime-mes1",
    tcc = ":tcc-mes1",
)

command_test(
    name = "mes1-version",
    args = ["-version"],
    tool = ":tcc-mes1",
)

release_test_objects(
    name = "mes1",
    toolchain = ":mes1-compiler",
)

release_test_programs(
    name = "mes1",
    objects = "mes1",
    runtime = ":mes1-link-runtime",
    toolchain = ":mes1-compiler",
)

[
    command_test(
        name = name + "-diagnostics",
        args = [
            "1",
            "$(exe :tcc-" + name + ")",
            "-c",
            "$(location " + BOOT + ":test-source[tests/invalid.c])",
            "-o",
            "/dev/null",
        ],
        tool = "cellar//bootstrap/stage1/tools:expect-exit",
    )
    for name in [
        "mes0",
        "mes1",
    ]
]

# An archive may have no members, and the assembler accepts both MXCSR
# instructions, including memory operands relative to the stack.
c_library(
    name = "empty.a",
    objects = [],
    output = "empty.a",
    toolchain = ":mes1-compiler",
)

[
    c_object(
        name = "mxcsr-" + name + ".o",
        src = "tests/mxcsr." + extension,
        object_name = name + ".o",
        toolchain = ":mes1-compiler",
    )
    for name, extension in [
        ("main", "c"),
        ("asm", "S"),
    ]
]

c_binary(
    name = "mxcsr-program",
    libraries = [
        ":empty.a",
        ":mes0-libc.a",
        ":mes1-libtcc1.a",
    ],
    objects = [
        ":mes0-crt1.o",
        ":mxcsr-main.o",
        ":mxcsr-asm.o",
    ],
    toolchain = ":mes1-compiler",
)

command_test(
    name = "mxcsr-and-empty-archive",
    tool = ":mxcsr-program",
)

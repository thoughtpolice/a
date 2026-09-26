# SPDX-FileCopyrightText: © 2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

load("@cellar//bootstrap:actions.bzl", "command_test", "generate")
load("@cellar//bootstrap:defs.bzl", "export_file", "filegroup")
load("@cellar//bootstrap:source.bzl", "exact_patch")
load("@cellar//bootstrap/stage1:defs.bzl", "c_binary", "c_library", "c_object", "link_runtime", "sysroot")
load("@cellar//bootstrap/stage1/musl:defs.bzl", "EMPTY_LIBRARIES", "gnu_as_object")
load("@cellar//bootstrap/stage1/tcc-release:defs.bzl", "release_defines", "release_tcc")
load(":defs.bzl", "gnu_tcc_toolchain")

MUSL = "cellar//bootstrap/stage1/musl"

RELEASE = "cellar//bootstrap/stage1/tcc-release"

AS = "cellar//bootstrap/stage1/binutils:as"

DEFINES = release_defines("/musl/loader")

[export_file(name = path) for path in glob([
    "patches/*.patch",
    "tests/*.c",
    "*.s",
])]

# TCC's hexadecimal float reader rounded through double, which corrupts
# musl's long double constants.
[
    exact_patch(
        name = name,
        src = source,
        output = "tccpp.c",
        patch = ":patches/" + name + ".patch",
    )
    for name, source in [
        (
            "hex-start",
            RELEASE + ":source[tccpp.c]",
        ),
        ("hex-convert", ":hex-start"),
    ]
]

gnu_as_object(
    name = "scalbnl.o",
    src = ":scalbnl.s",
    action = "scalbnl-asm",
    assembler = AS,
    output = "scalbnl.o",
)

# hexfloat: the self-hosted musl-linked TCC, archiving and linking with GNU
# binutils, builds the corrected compiler against the restored musl. It links
# the x87 scalbnl, since that musl's own scalbnl has the corrupted constants.
gnu_tcc_toolchain(
    name = "hexfloat-predecessor",
    cflags = ["-nostdinc"],
    execution_runtime = MUSL + ":runtime-rebuilt",
    sysroot = MUSL + ":runtime-restored",
    tcc = "cellar//bootstrap/stage1/tcc-musl:tcc-musl2",
)

# TCC compiles, GNU as assembles, GNU ar archives and GNU ld links one
# program with this compiler.
c_library(
    name = "gnu-test.a",
    objects = ["cellar//bootstrap/stage1/binutils:as-fixture.o"],
    output = "native.a",
    toolchain = ":hexfloat-predecessor",
)

c_binary(
    name = "gnu-toolchain-test-bin",
    libraries = [":gnu-test.a"],
    objects = ["cellar//bootstrap/stage1/binutils:as-test.o"],
    output = "gnu-toolchain-test",
    runtime = MUSL + ":tcc-link-runtime",
    toolchain = ":hexfloat-predecessor",
)

command_test(
    name = "gnu-toolchain-link",
    tool = ":gnu-toolchain-test-bin",
)

release_tcc(
    name = "hexfloat",
    defines = DEFINES,
    extra_objects = [":scalbnl.o"],
    headers = [
        RELEASE + ":source",
        MUSL + ":headers",
    ],
    # do not sort
    includes = [
        RELEASE + ":source",
        MUSL + ":headers",
    ],
    runtime = MUSL + ":tcc-link-runtime",
    sources = {"tccpp.c": ":hex-convert"},
    toolchain = ":hexfloat-predecessor",
)

filegroup(
    name = "hexfloat-execution-runtime",
    srcs = {
        "sysroot": MUSL + ":runtime-restored",
        "scalbnl.o": ":scalbnl.o",
    },
)

gnu_tcc_toolchain(
    name = "hexfloat",
    cflags = ["-nostdinc"],
    execution_runtime = ":hexfloat-execution-runtime",
    sysroot = MUSL + ":runtime-restored",
    tcc = ":tcc-hexfloat",
)

[
    [
        c_object(
            name = name + "-test.o",
            src = ":tests/hexfloat.c" if name == "hexfloat" else MUSL + ":test-source[tests/" + name + ".c]",
            flags = ["-Werror"],
            headers = [MUSL + ":headers"],
            includes = [MUSL + ":headers"],
            object_name = "test.o",
            toolchain = ":hexfloat",
        ),
        c_binary(
            name = name + "-test-bin",
            objects = [":" + name + "-test.o"],
            runtime = MUSL + ":tcc-link-runtime",
            toolchain = ":hexfloat",
        ),
        command_test(
            name = name + "-test",
            args = [
                "startup",
                "ok",
            ] if name == "runtime" else [],
            env = {"BOOTSTRAP_TEST": "present"},
            tool = ":" + name + "-test-bin",
        ),
    ]
    for name in [
        "hexfloat",
        "headers",
        "runtime",
        "threads",
        "fenv",
        "syscalls",
        "unicode",
    ]
]

command_test(
    name = "version",
    args = ["-version"],
    tool = ":tcc-hexfloat",
)

# gnu: the corrected compiler rebuilds itself against the musl that GNU as
# assembled, which has the native x87 scalbnl.
gnu_tcc_toolchain(
    name = "gnu-predecessor",
    cflags = [
        "-nostdinc",
        "-isystem",
        "$(location " + MUSL + ":headers)",
    ],
    execution_runtime = ":hexfloat-execution-runtime",
    sysroot = MUSL + ":runtime-gnu",
    tcc = ":tcc-hexfloat",
)

release_tcc(
    name = "gnu",
    defines = DEFINES,
    flags = ["-Werror"],
    headers = [
        RELEASE + ":source",
        MUSL + ":headers",
    ],
    includes = [RELEASE + ":source"],
    runtime = MUSL + ":gnu-link-runtime",
    sources = {"tccpp.c": ":hex-convert"},
    toolchain = ":gnu-predecessor",
)

# The new compiler builds its own support library. GNU as assembles alloca
# from the preprocessed source.
gnu_tcc_toolchain(
    name = "support-compiler",
    cflags = [
        "-nostdinc",
        "-isystem",
        "$(location " + MUSL + ":headers)",
    ],
    execution_runtime = MUSL + ":runtime-gnu",
    sysroot = MUSL + ":runtime-gnu",
    tcc = ":tcc-gnu",
)

[
    c_object(
        name = name + ".o",
        src = RELEASE + ":source[lib/" + path + "]",
        defines = ["TCC_TARGET_X86_64=1"],
        flags = ["-Werror"],
        headers = [MUSL + ":headers"],
        object_name = name + ".o",
        toolchain = ":support-compiler",
    )
    for name, path in [
        ("support", "libtcc1.c"),
        ("varargs", "va_list.c"),
    ]
]

generate(
    name = "alloca.s",
    args = [
        "-E",
        "$(location " + RELEASE + ":source[lib/alloca86_64.S])",
    ],
    capture = True,
    tool = ":support-compiler",
)

gnu_as_object(
    name = "alloca.o",
    src = ":alloca.s",
    action = "alloca-asm",
    assembler = AS,
    output = "alloca.o",
)

c_library(
    name = "libtcc1.a",
    objects = [
        ":support.o",
        ":varargs.o",
        ":alloca.o",
    ],
    output = "libtcc1.a",
    toolchain = ":support-compiler",
)

sysroot(
    name = "runtime",
    abi = "x86_64-sysv",
    files = {"include": MUSL + ":headers"},
    libraries = {
        "lib/lib" + library + ".a": MUSL + ":gnu-lib" + library + ".a"
        for library in ["c"] + EMPTY_LIBRARIES
    } | {"lib/libtcc1.a": ":libtcc1.a"},
    object_format = "elf64-x86-64",
    objects = {"lib/" + crt + ".o": MUSL + ":gnu-" + crt + ".o" for crt in [
        "crt1",
        "crti",
        "crtn",
    ]},
)

# What a program that the tcc compiler links gets around its own objects.
link_runtime(
    name = "link-runtime",
    end_objects = [MUSL + ":gnu-crtn.o"],
    libraries = [
        MUSL + ":gnu-libc.a",
        ":libtcc1.a",
        MUSL + ":gnu-libc.a",
    ],
    start_objects = [
        MUSL + ":gnu-crt1.o",
        MUSL + ":gnu-crti.o",
    ],
)

# The final TCC toolchain: the corrected compiler with its own support
# library, the GNU-assembled musl, and GNU ar and ld.
gnu_tcc_toolchain(
    name = "tcc",
    cflags = [
        "-nostdinc",
        "-isystem",
        "$(location " + MUSL + ":headers)",
    ],
    execution_runtime = MUSL + ":runtime-gnu",
    sysroot = ":runtime",
    tcc = ":tcc-gnu",
)

[
    [
        c_object(
            name = "gnu-" + name + "-test.o",
            src = ":tests/hexfloat.c" if name == "hexfloat" else MUSL + ":test-source[tests/" + name + ".c]",
            flags = ["-Werror"],
            headers = [MUSL + ":headers"],
            object_name = "test.o",
            toolchain = ":tcc",
        ),
        c_binary(
            name = "gnu-" + name + "-test-bin",
            objects = [":gnu-" + name + "-test.o"],
            runtime = ":link-runtime",
            toolchain = ":tcc",
        ),
        command_test(
            name = "gnu-" + name + "-test",
            args = [
                "startup",
                "ok",
            ] if name == "runtime" else [],
            env = {"BOOTSTRAP_TEST": "present"},
            tool = ":gnu-" + name + "-test-bin",
        ),
    ]
    for name in [
        "hexfloat",
        "headers",
        "runtime",
        "threads",
        "fenv",
        "syscalls",
        "unicode",
        "native-math",
    ]
]

# Exercise the runnable driver's own static linker against GNU-created archives.
generate(
    name = "driver-program",
    args = [
        "$(location " + MUSL + ":test-source[tests/runtime.c])",
        "-o",
    ],
    output = "program",
    tool = ":tcc",
)

command_test(
    name = "gnu-driver",
    args = [
        "0",
        "$(location :driver-program)",
        "startup",
        "ok",
    ],
    env = {"BOOTSTRAP_TEST": "present"},
    tool = "cellar//bootstrap/stage1/tools:expect-exit",
)

command_test(
    name = "gnu-version",
    args = ["-version"],
    tool = ":tcc-gnu",
)

[
    command_test(
        name = "gnu-missing-" + name,
        args = [
            "1",
            "$(exe :tcc-gnu)",
            "-B",
            "$(location cellar//bootstrap/stage1/tcc:empty-sysroot)",
        ] + flags + [
            "$(location :tests/" + source + ")",
            "-o",
            "/dev/null",
        ],
        tool = "cellar//bootstrap/stage1/tools:expect-exit",
    )
    for name, flags, source in [
        (
            "headers",
            ["-c"],
            "hexfloat.c",
        ),
        ("libraries", [], "missing-sysroot.c"),
    ]
]

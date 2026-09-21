# SPDX-FileCopyrightText: 2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

load("@cellar//bootstrap:actions.bzl", "command_test", "generate")
load("@cellar//bootstrap:defs.bzl", "export_file", "filegroup")
load("@cellar//bootstrap/stage1:defs.bzl", "bootstrap_artifact", "c_binary", "c_library", "c_object", "compiler", "sysroot")
load("@cellar//bootstrap/stage1/tcc:sources.bzl", "COMPILER_SOURCES")

MUSL = "cellar//bootstrap/stage1/musl"

RELEASE = "cellar//bootstrap/stage1/tcc-release"

BINUTILS = "cellar//bootstrap/stage1/binutils"

PREDECESSOR = BINUTILS + ":tcc-with-binutils"

DEFINES = [
    "TCC_TARGET_X86_64=1",
    "ONE_SOURCE=0",
    "CONFIG_TCC_STATIC=1",
    "CONFIG_TCCBOOT=1",
    'TCC_VERSION="0.9.27"',
    'CONFIG_TCCDIR=""',
    'CONFIG_SYSROOT=""',
    'CONFIG_TCC_CRTPREFIX="{B}/lib"',
    'CONFIG_TCC_LIBPATHS="{B}/lib"',
    'CONFIG_TCC_SYSINCLUDEPATHS="{B}/include"',
    'TCC_LIBTCC1="lib/libtcc1.a"',
    'CONFIG_TCC_ELFINTERP="/musl/loader"',
]

CRT = [
    MUSL + ":restored-crt1.o",
    MUSL + ":restored-crti.o",
]

CRTN = [MUSL + ":restored-crtn.o"]

LIBC = [
    MUSL + ":restored-libc.a",
    "cellar//bootstrap/stage1/tcc-musl:musl2-libtcc1.a",
    MUSL + ":restored-libc.a",
]

[export_file(name = path) for path in glob([
    "patches/*",
    "tests/*.c",
    "*.s",
])]

[
    generate(
        name = name,
        args = [
            "$(location " + source + ")",
            "$(location :patches/" + name + ".before)",
            "$(location :patches/" + name + ".after)",
        ],
        output = "tccpp.c",
        tool = "cellar//bootstrap/stage1/simple-patch:simple-patch",
    )
    for name, source in [
        (
            "hex-start",
            RELEASE + ":source[tccpp.c]",
        ),
        ("hex-convert", ":hex-start"),
    ]
]

generate(
    name = "scalbnl-asm",
    args = [
        "--64",
        "$(location :scalbnl.s)",
        "-o",
    ],
    output = "scalbnl.o",
    tool = BINUTILS + ":as",
)

bootstrap_artifact(
    name = "scalbnl.o",
    src = ":scalbnl-asm",
    abi = "x86_64-sysv",
    kind = "object",
    object_format = "elf64-x86-64",
)

[
    c_object(
        name = "hexfloat-{}.o".format(i),
        src = ":hex-convert" if path == "tccpp.c" else RELEASE + ":source[" + path + "]",
        defines = DEFINES,
        headers = [
            RELEASE + ":source",
            MUSL + ":headers",
        ],
        # do not sort
        includes = [
            RELEASE + ":source",
            MUSL + ":headers",
        ],
        object_name = "t{}.o".format(i),
        toolchain = PREDECESSOR,
    )
    for i, path in enumerate(["tcc.c"] + COMPILER_SOURCES)
]

c_library(
    name = "hexfloat-libtcc.a",
    objects = [":hexfloat-{}.o".format(i + 1) for i in range(len(COMPILER_SOURCES))],
    output = "libtcc.a",
    toolchain = PREDECESSOR,
)

c_binary(
    name = "tcc-hexfloat",
    libraries = [":hexfloat-libtcc.a"] + LIBC,
    objects = CRT + [
        ":hexfloat-0.o",
        ":scalbnl.o",
    ] + CRTN,
    output = "tcc",
    toolchain = PREDECESSOR,
)

filegroup(
    name = "hexfloat-execution-runtime",
    srcs = {
        "sysroot": MUSL + ":runtime-restored",
        "scalbnl.o": ":scalbnl.o",
    },
)

compiler(
    name = "hexfloat",
    abi = "x86_64-sysv",
    archive_flags = ["crsD"],
    archive_format = "ar",
    archiver = BINUTILS + ":ar",
    cflags = ["-nostdinc"],
    compiler = ":tcc-hexfloat",
    execution_runtime = ":hexfloat-execution-runtime",
    family = "tcc",
    ldflags = ["-static"],
    linker = BINUTILS + ":ld",
    object_format = "elf64-x86-64",
    stage = "native-hexfloat-correction",
    sysroot = MUSL + ":runtime-restored",
    target_compatible_with = [
        "cellar//bootstrap/platforms:linux",
        "cellar//bootstrap/platforms:amd64",
    ],
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
            libraries = LIBC,
            objects = CRT + [":" + name + "-test.o"] + CRTN,
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

# Final pre-GCC TCC: corrected compiler, GNU-built musl, GNU ar/as/ld.
GNU_CRT = [
    MUSL + ":gnu-crt1.o",
    MUSL + ":gnu-crti.o",
]

GNU_CRTN = [MUSL + ":gnu-crtn.o"]

GNU_LIBC = [
    MUSL + ":gnu-libc.a",
    "cellar//bootstrap/stage1/tcc-musl:musl2-libtcc1.a",
    MUSL + ":gnu-libc.a",
]

compiler(
    name = "gnu-predecessor",
    abi = "x86_64-sysv",
    archive_flags = ["crsD"],
    archive_format = "ar",
    archiver = BINUTILS + ":ar",
    cflags = [
        "-nostdinc",
        "-isystem",
        "$(location " + MUSL + ":headers)",
    ],
    compiler = ":tcc-hexfloat",
    execution_runtime = ":hexfloat-execution-runtime",
    family = "tcc",
    ldflags = ["-static"],
    linker = BINUTILS + ":ld",
    object_format = "elf64-x86-64",
    stage = "gnu-musl-tcc-predecessor",
    sysroot = MUSL + ":runtime-gnu",
    target_compatible_with = [
        "cellar//bootstrap/platforms:linux",
        "cellar//bootstrap/platforms:amd64",
    ],
)

[
    c_object(
        name = "gnu-{}.o".format(i),
        src = ":hex-convert" if path == "tccpp.c" else RELEASE + ":source[" + path + "]",
        defines = DEFINES,
        flags = ["-Werror"],
        headers = [
            RELEASE + ":source",
            MUSL + ":headers",
        ],
        includes = [RELEASE + ":source"],
        object_name = "t{}.o".format(i),
        toolchain = ":gnu-predecessor",
    )
    for i, path in enumerate(["tcc.c"] + COMPILER_SOURCES)
]

c_library(
    name = "libtcc.a",
    objects = [":gnu-{}.o".format(i + 1) for i in range(len(COMPILER_SOURCES))],
    output = "libtcc.a",
    toolchain = ":gnu-predecessor",
)

c_binary(
    name = "tcc-gnu",
    libraries = [":libtcc.a"] + GNU_LIBC,
    objects = GNU_CRT + [":gnu-0.o"] + GNU_CRTN,
    output = "tcc",
    toolchain = ":gnu-predecessor",
)

compiler(
    name = "support-compiler",
    abi = "x86_64-sysv",
    archive_flags = ["crsD"],
    archive_format = "ar",
    archiver = BINUTILS + ":ar",
    cflags = [
        "-nostdinc",
        "-isystem",
        "$(location " + MUSL + ":headers)",
    ],
    compiler = ":tcc-gnu",
    execution_runtime = MUSL + ":runtime-gnu",
    family = "tcc",
    ldflags = ["-static"],
    linker = BINUTILS + ":ld",
    object_format = "elf64-x86-64",
    stage = "gnu-musl-tcc-support",
    sysroot = MUSL + ":runtime-gnu",
    target_compatible_with = [
        "cellar//bootstrap/platforms:linux",
        "cellar//bootstrap/platforms:amd64",
    ],
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
    capture = "cellar//bootstrap/stage1/tools:capture",
    tool = ":support-compiler",
)

generate(
    name = "alloca-asm",
    args = [
        "--64",
        "$(location :alloca.s)",
        "-o",
    ],
    output = "alloca.o",
    tool = BINUTILS + ":as",
)

bootstrap_artifact(
    name = "alloca.o",
    src = ":alloca-asm",
    abi = "x86_64-sysv",
    kind = "object",
    object_format = "elf64-x86-64",
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
    libraries = {"lib/lib" + name + ".a": MUSL + ":gnu-lib" + name + ".a" for name in [
        "c",
        "m",
        "rt",
        "pthread",
        "crypt",
        "util",
        "xnet",
        "resolv",
        "dl",
    ]} | {"lib/libtcc1.a": ":libtcc1.a"},
    object_format = "elf64-x86-64",
    objects = {"lib/" + name + ".o": MUSL + ":gnu-" + name + ".o" for name in [
        "crt1",
        "crti",
        "crtn",
    ]},
)

compiler(
    name = "tcc",
    abi = "x86_64-sysv",
    archive_flags = ["crsD"],
    archive_format = "ar",
    archiver = BINUTILS + ":ar",
    cflags = [
        "-nostdinc",
        "-isystem",
        "$(location " + MUSL + ":headers)",
    ],
    compiler = ":tcc-gnu",
    execution_runtime = MUSL + ":runtime-gnu",
    family = "tcc",
    ldflags = ["-static"],
    linker = BINUTILS + ":ld",
    object_format = "elf64-x86-64",
    stage = "native-pre-gcc-tcc",
    sysroot = ":runtime",
    target_compatible_with = [
        "cellar//bootstrap/platforms:linux",
        "cellar//bootstrap/platforms:amd64",
    ],
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
            libraries = [
                MUSL + ":gnu-libc.a",
                ":libtcc1.a",
                MUSL + ":gnu-libc.a",
            ],
            objects = GNU_CRT + [":gnu-" + name + "-test.o"] + GNU_CRTN,
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

filegroup(
    name = "installation",
    srcs = {
        "bin/tcc": ":tcc-gnu",
        "sysroot": ":runtime",
        "lib/libtcc.a": ":libtcc.a",
    },
)

[
    command_test(
        name = "gnu-missing-" + name,
        args = [
            "1",
            "$(location :tcc-gnu)",
            "-B",
            "/nonexistent-bootstrap-sysroot",
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

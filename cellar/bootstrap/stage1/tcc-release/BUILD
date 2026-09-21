# SPDX-FileCopyrightText: © 2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

load("@cellar//bootstrap:actions.bzl", "command_test", "generate")
load("@cellar//bootstrap:defs.bzl", "export_file", "filegroup")
load("@cellar//bootstrap:source.bzl", "download_file", "untar", "write_file")
load("@cellar//bootstrap/stage1:defs.bzl", "c_binary", "c_library", "c_object", "compiler", "sysroot")
load("@cellar//bootstrap/stage1/tcc:sources.bzl", "COMPILER_SOURCES", "LIBC_SOURCES")
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
    chdirenv = "cellar//bootstrap/stage0-posix/cellar-extra:chdirenv",
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
    generate(
        name = name,
        args = [
            "$(location " + src + ")",
            "$(location :patches/" + patch + ".before)",
            "$(location :patches/" + patch + ".after)",
        ],
        output = output,
        tool = "cellar//bootstrap/stage1/simple-patch:simple-patch",
    )
    for name, src, patch, output in [
        ("tcctools-remove", ":tcc-0.9.27[tcctools.c]", "remove-fileopen", "tcctools.c"),
        ("tcctools-open", ":tcctools-remove", "addback-fileopen", "tcctools.c"),
        ("tcctools", ":tcctools-open", "weak-index", "tcctools.c"),
        ("libtcc", ":tcc-0.9.27[libtcc.c]", "static-default", "libtcc.c"),
        ("tccelf-got", ":tcc-0.9.27[tccelf.c]", "check-reloc-null", "tccelf.c"),
        ("tccelf-static", ":tccelf-got", "static-calls", "tccelf.c"),
        ("tccelf", ":tccelf-static", "got-before-tidy", "tccelf.c"),
        ("tccgen", ":tcc-0.9.27[tccgen.c]", "array-quals", "tccgen.c"),
    ]
]

[export_file(name = path) for path in glob(["patches/*"])]

filegroup(
    name = "source",
    srcs = {path: ":tcc-0.9.27[{}]".format(path) for path in TCC_FILES} | {
        "config.h": ":config.h",
        "tcctools.c": ":tcctools",
        "libtcc.c": ":libtcc",
        "tccelf.c": ":tccelf",
        "tccgen.c": ":tccgen",
    },
)

BOOT = "cellar//bootstrap/stage1/tcc"

COMPAT = [
    "cellar//bootstrap/platforms:linux",
    "cellar//bootstrap/platforms:amd64",
]

# Full release features, with a static native compiler and an explicit sysroot.
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
    'CONFIG_TCC_ELFINTERP="/mes/loader"',
]

[
    c_object(
        name = "mes0-compiler-{}.o".format(i),
        src = ":source[{}]".format(path),
        defines = DEFINES,
        flags = ["-nostdinc"],
        headers = [
            ":source",
            BOOT + ":headers",
        ],
        includes = [
            ":source",
            BOOT + ":headers",
        ],
        object_name = "t{}.o".format(i),
        target_compatible_with = COMPAT,
        toolchain = BOOT + ":tcc",
    )
    for i, path in enumerate(["tcc.c"] + COMPILER_SOURCES)
]

c_library(
    name = "mes0-libtcc.a",
    objects = [":mes0-compiler-{}.o".format(i + 1) for i in range(len(COMPILER_SOURCES))],
    output = "libtcc.a",
    toolchain = BOOT + ":tcc",
)

c_binary(
    name = "tcc-mes0",
    flags = [
        "-nostdlib",
        "-static",
    ],
    libraries = [
        ":mes0-libtcc.a",
        BOOT + ":boot2-libc.a",
        BOOT + ":boot2-libtcc1.a",
        BOOT + ":boot2-libc.a",
    ],
    objects = [
        BOOT + ":boot2-crt1.o",
        ":mes0-compiler-0.o",
    ],
    output = "tcc",
    toolchain = BOOT + ":tcc",
)

compiler(
    name = "mes0-compiler",
    abi = "x86_64-sysv",
    archive_flags = [
        "-ar",
        "cr",
    ],
    archive_format = "ar",
    archiver = ":tcc-mes0",
    cflags = [
        "-nostdinc",
        "-D__SIZEOF_LONG_LONG__=8",
        "-I",
        "$(location " + BOOT + ":headers)",
    ],
    compiler = ":tcc-mes0",
    execution_runtime = BOOT + ":runtime-boot2",
    family = "tcc",
    ldflags = [
        "-nostdlib",
        "-static",
    ],
    object_format = "elf64-x86-64",
    stage = "release-mes0",
    sysroot = BOOT + ":runtime-boot2",
    target_compatible_with = COMPAT,
)

command_test(
    name = "mes0-version",
    args = ["-version"],
    tool = ":tcc-mes0",
)

[
    c_object(
        name = "mes0-test-" + name + ".o",
        src = src,
        headers = [BOOT + ":headers"],
        object_name = name + ".o",
        toolchain = ":mes0-compiler",
    )
    for name, src in [
        (
            "abi",
            BOOT + ":test-source[tests/abi.c]",
        ),
        (
            "probe",
            BOOT + ":test-source[tests/abi.S]",
        ),
        (
            "integer",
            BOOT + ":test-source[tests/integer.c]",
        ),
        (
            "features",
            BOOT + ":test-source[tests/features.c]",
        ),
        (
            "archive",
            BOOT + ":test-source[tests/archive.c]",
        ),
        (
            "weak",
            BOOT + ":test-source[tests/weak.c]",
        ),
        ("weak-only", "tests/weak-only.c"),
        ("array", "tests/array.c"),
    ]
]

[
    c_library(
        name = "mes0-test-" + name + ".a",
        objects = [":mes0-test-" + name + ".o"],
        output = name + ".a",
        toolchain = ":mes0-compiler",
    )
    for name in [
        "archive",
        "weak-only",
    ]
]

[
    c_binary(
        name = "mes0-" + name + "-program",
        libraries = libraries + [
            BOOT + ":boot2-libc.a",
            BOOT + ":boot2-libtcc1.a",
            BOOT + ":boot2-libc.a",
        ],
        objects = [BOOT + ":boot2-crt1.o"] + [":mes0-test-" + obj + ".o" for obj in objects],
        toolchain = ":mes0-compiler",
    )
    for name, objects, libraries in [
        (
            "abi",
            [
                "abi",
                "probe",
            ],
            [],
        ),
        (
            "integer",
            ["integer"],
            [],
        ),
        (
            "features",
            [
                "features",
                "weak",
            ],
            [":mes0-test-archive.a"],
        ),
        (
            "array",
            ["array"],
            [":mes0-test-weak-only.a"],
        ),
    ]
]

command_test(
    name = "mes0-abi",
    args = [
        "startup",
        "ok",
    ],
    env = {"BOOTSTRAP_TEST": "present"},
    tool = ":mes0-abi-program",
)

[
    command_test(
        name = "mes0-" + name,
        tool = ":mes0-" + name + "-program",
    )
    for name in [
        "integer",
        "features",
        "array",
    ]
]

command_test(
    name = "mes0-diagnostics",
    args = [
        "1",
        "$(location :tcc-mes0)",
        "-c",
        "$(location " + BOOT + ":test-source[tests/invalid.c])",
        "-o",
        "/dev/null",
    ],
    tool = "cellar//bootstrap/stage1/tools:expect-exit",
)

# Published pass1 rebuilds the conventional Mes runtime with release TCC.
# The compiler remains linked with its predecessor runtime while doing so.
MES = "cellar//bootstrap/mes"

[
    c_object(
        name = "mes0-libc-{}.o".format(i),
        src = {
            "lib/mes/__buffered_read.c": BOOT + ":buffered-read.c",
            "lib/mes/abtod.c": BOOT + ":abtod.c",
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

[
    c_binary(
        name = "rebuilt-mes-" + name + "-program",
        libraries = libraries + [
            ":mes0-libc.a",
            ":mes0-libtcc1.a",
            ":mes0-libc.a",
        ],
        objects = [":mes0-crt1.o"] + [":mes0-test-" + obj + ".o" for obj in objects],
        toolchain = ":mes0-compiler",
    )
    for name, objects, libraries in [
        (
            "abi",
            [
                "abi",
                "probe",
            ],
            [],
        ),
        (
            "integer",
            ["integer"],
            [],
        ),
        (
            "features",
            [
                "features",
                "weak",
            ],
            [":mes0-test-archive.a"],
        ),
        (
            "array",
            ["array"],
            [":mes0-test-weak-only.a"],
        ),
    ]
]

command_test(
    name = "rebuilt-mes-abi",
    args = [
        "startup",
        "ok",
    ],
    env = {"BOOTSTRAP_TEST": "present"},
    tool = ":rebuilt-mes-abi-program",
)

[
    command_test(
        name = "rebuilt-mes-" + name,
        tool = ":rebuilt-mes-" + name + "-program",
    )
    for name in [
        "integer",
        "features",
        "array",
    ]
]

# Published pass2 keeps 0.9.26 as the compiler, linking the release against
# the rebuilt Mes runtime. Release TCC only becomes self-hosting with musl.
compiler(
    name = "mes1-predecessor",
    abi = "x86_64-sysv",
    archive_flags = [
        "-ar",
        "cr",
    ],
    archive_format = "ar",
    archiver = BOOT + ":tcc-boot2",
    cflags = [
        "-nostdinc",
        "-I",
        "$(location " + BOOT + ":headers)",
    ],
    compiler = BOOT + ":tcc-boot2",
    execution_runtime = BOOT + ":runtime-boot1",
    family = "tcc",
    ldflags = [
        "-nostdlib",
        "-static",
    ],
    object_format = "elf64-x86-64",
    stage = "fixed-point-for-release-pass2",
    sysroot = ":runtime-mes0",
    target_compatible_with = COMPAT,
)

[
    c_object(
        name = "mes1-compiler-{}.o".format(i),
        src = ":source[{}]".format(path),
        defines = DEFINES,
        headers = [
            ":source",
            BOOT + ":headers",
        ],
        includes = [":source"],
        object_name = "t{}.o".format(i),
        toolchain = ":mes1-predecessor",
    )
    for i, path in enumerate(["tcc.c"] + COMPILER_SOURCES)
]

c_library(
    name = "mes1-libtcc.a",
    objects = [":mes1-compiler-{}.o".format(i + 1) for i in range(len(COMPILER_SOURCES))],
    output = "libtcc.a",
    toolchain = ":mes1-predecessor",
)

c_binary(
    name = "tcc-mes1",
    libraries = [
        ":mes1-libtcc.a",
        ":mes0-libc.a",
        ":mes0-libtcc1.a",
        ":mes0-libc.a",
    ],
    objects = [
        ":mes0-crt1.o",
        ":mes1-compiler-0.o",
    ],
    output = "tcc",
    toolchain = ":mes1-predecessor",
)

[
    c_object(
        name = "mes1-" + name + ".o",
        src = ":source[" + src + "]",
        defines = ["TCC_TARGET_X86_64=1"],
        object_name = name + ".o",
        toolchain = ":mes1-predecessor",
    )
    for name, src in [
        ("support", "lib/libtcc1.c"),
        ("varargs", "lib/va_list.c"),
        ("alloca", "lib/alloca86_64.S"),
    ]
]

c_library(
    name = "mes1-libtcc1.a",
    objects = [":mes1-" + name + ".o" for name in [
        "support",
        "varargs",
        "alloca",
    ]],
    output = "libtcc1.a",
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

compiler(
    name = "mes1-compiler",
    abi = "x86_64-sysv",
    archive_flags = [
        "-ar",
        "cr",
    ],
    archive_format = "ar",
    archiver = ":tcc-mes1",
    cflags = [
        "-nostdinc",
        "-D__SIZEOF_LONG_LONG__=8",
        "-I",
        "$(location " + BOOT + ":headers)",
    ],
    compiler = ":tcc-mes1",
    execution_runtime = ":runtime-mes0",
    family = "tcc",
    ldflags = [
        "-nostdlib",
        "-static",
    ],
    object_format = "elf64-x86-64",
    stage = "release-mes1",
    sysroot = ":runtime-mes1",
    target_compatible_with = COMPAT,
)

command_test(
    name = "mes1-version",
    args = ["-version"],
    tool = ":tcc-mes1",
)

[
    c_object(
        name = "mes1-test-" + name + ".o",
        src = src,
        headers = [BOOT + ":headers"],
        object_name = name + ".o",
        toolchain = ":mes1-compiler",
    )
    for name, src in [
        (
            "abi",
            BOOT + ":test-source[tests/abi.c]",
        ),
        (
            "probe",
            BOOT + ":test-source[tests/abi.S]",
        ),
        (
            "integer",
            BOOT + ":test-source[tests/integer.c]",
        ),
        (
            "features",
            BOOT + ":test-source[tests/features.c]",
        ),
        (
            "archive",
            BOOT + ":test-source[tests/archive.c]",
        ),
        (
            "weak",
            BOOT + ":test-source[tests/weak.c]",
        ),
        ("weak-only", "tests/weak-only.c"),
        ("array", "tests/array.c"),
    ]
]

[
    c_library(
        name = "mes1-test-" + name + ".a",
        objects = [":mes1-test-" + name + ".o"],
        output = name + ".a",
        toolchain = ":mes1-compiler",
    )
    for name in [
        "archive",
        "weak-only",
    ]
]

[
    c_binary(
        name = "mes1-" + name + "-program",
        libraries = libraries + [
            ":mes0-libc.a",
            ":mes1-libtcc1.a",
            ":mes0-libc.a",
        ],
        objects = [":mes0-crt1.o"] + [":mes1-test-" + obj + ".o" for obj in objects],
        toolchain = ":mes1-compiler",
    )
    for name, objects, libraries in [
        (
            "abi",
            [
                "abi",
                "probe",
            ],
            [],
        ),
        (
            "integer",
            ["integer"],
            [],
        ),
        (
            "features",
            [
                "features",
                "weak",
            ],
            [":mes1-test-archive.a"],
        ),
        (
            "array",
            ["array"],
            [":mes1-test-weak-only.a"],
        ),
    ]
]

command_test(
    name = "mes1-abi",
    args = [
        "startup",
        "ok",
    ],
    env = {"BOOTSTRAP_TEST": "present"},
    tool = ":mes1-abi-program",
)

[
    command_test(
        name = "mes1-" + name,
        tool = ":mes1-" + name + "-program",
    )
    for name in [
        "integer",
        "features",
        "array",
    ]
]

command_test(
    name = "mes1-diagnostics",
    args = [
        "1",
        "$(location :tcc-mes0)",
        "-c",
        "$(location " + BOOT + ":test-source[tests/invalid.c])",
        "-o",
        "/dev/null",
    ],
    tool = "cellar//bootstrap/stage1/tools:expect-exit",
)

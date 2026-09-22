# SPDX-FileCopyrightText: © 2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

load("@cellar//bootstrap:actions.bzl", "command_test")
load("@cellar//bootstrap:defs.bzl", "export_file", "filegroup")
load("@cellar//bootstrap:source.bzl", "download_file", "exact_patch", "ungz", "untar", "write_file")
load("@cellar//bootstrap/mes:manifest.bzl", "PREPARED_FILES")
load("@cellar//bootstrap/stage1:defs.bzl", "bootstrap_artifact", "c_binary", "c_library", "c_object", "compiler", "sysroot")
load(":sources.bzl", "COMPILER_SOURCES", "LIBC_SOURCES", "TCC_FILES")

COMPAT = [
    "cellar//bootstrap/platforms:linux",
    "cellar//bootstrap/platforms:amd64",
]

filegroup(
    name = "runtime-source",
    srcs = ["runtime/" + name for name in [
        "crt1.S",
        "empty.S",
        "exit.S",
        "setjmp.S",
        "ldexp.c",
    ]],
)

filegroup(
    name = "test-source",
    srcs = ["tests/" + name for name in [
        "abi.c",
        "abi.S",
        "integer.c",
        "features.c",
        "archive.c",
        "weak.c",
        "invalid.c",
    ]],
)

MES = "cellar//bootstrap/mes"

TOOLS = "cellar//bootstrap/stage0-posix/mescc-tools-extra"

HELPERS = "cellar//bootstrap/stage0-posix/cellar-extra"

download_file(
    name = "tcc.tar.gz",
    hash = "6b8cbd0a5fed0636d4f0f763a603247bc1935e206e1cc5bda6a2818bab6e819f",
    urls = ["https://lilypond.org/janneke/tcc/tcc-0.9.26-1147-gee75a10c.tar.gz"],
)

ungz(
    name = "tcc.tar",
    input = ":tcc.tar.gz",
    ungz = TOOLS + ":ungz",
)

untar(
    name = "tcc-0.9.26-1147-gee75a10c",
    chdirenv = HELPERS + ":chdirenv",
    files = TCC_FILES + ["lib/libtcc1.c"],
    input = ":tcc.tar",
    untar = TOOLS + ":untar",
)

# Reference fixes: delay opening the archive until option parsing is complete.
[
    exact_patch(
        name = name,
        src = src,
        output = "tcctools.c",
        patch = ":patches/" + patch + ".patch",
    )
    for name, src, patch in [
        ("tcctools-remove", ":tcc-0.9.26-1147-gee75a10c[tcctools.c]", "remove-fileopen"),
        ("tcctools-addback", ":tcctools-remove", "addback-fileopen"),
        ("tcctools-init", ":tcctools-addback", "archive-init"),
        ("tcctools", ":tcctools-init", "archive-fields"),
    ]
]

write_file(
    name = "config.h",
    content = "/* Configuration is declared in BUILD. */\n",
)

exact_patch(
    name = "x86_64-gen.c",
    src = ":tcc-0.9.26-1147-gee75a10c[x86_64-gen.c]",
    output = "x86_64-gen.c",
    patch = ":patches/struct-init.patch",
)

exact_patch(
    name = "tccelf.c",
    src = ":tcc-0.9.26-1147-gee75a10c[tccelf.c]",
    output = "tccelf.c",
    patch = ":patches/static-calls.patch",
)

filegroup(
    name = "source",
    srcs = {path: ":tcc-0.9.26-1147-gee75a10c[{}]".format(path) for path in TCC_FILES if path not in [
        "tcctools.c",
        "x86_64-gen.c",
    ]} | {
        "tcctools.c": ":tcctools",
        "x86_64-gen.c": ":x86_64-gen.c",
        "tccelf.c": ":tccelf.c",
        "config.h": ":config.h",
    },
)

# Identical path configuration for all generations. The caller supplies -B.
DEFINES = [
    "BOOTSTRAP=1",
    "HAVE_LONG_LONG=1",
    "TCC_TARGET_X86_64=1",
    "inline=",
    'CONFIG_TCCDIR=""',
    'CONFIG_SYSROOT=""',
    'CONFIG_TCC_CRTPREFIX="{B}/lib"',
    'CONFIG_TCC_LIBPATHS="{B}/lib"',
    'CONFIG_TCC_SYSINCLUDEPATHS="{B}/include"',
    'CONFIG_TCC_ELFINTERP="/mes/loader"',
    'TCC_LIBTCC1="lib/libtcc1.a"',
    "CONFIG_TCC_LIBTCC1_MES=0",
    "CONFIG_TCCBOOT=1",
    "CONFIG_TCC_STATIC=1",
    'TCC_VERSION="0.9.26"',
]

compiler(
    name = "mescc",
    abi = "x86_64-mes",
    archive_format = "mes-concat",
    archiver = TOOLS + ":catm",
    cflags = [
        "-nostdinc",
        "-I",
        "$(location " + MES + ":mes-src[include])",
    ],
    compiler = MES + ":mescc",
    execution_runtime = MES + ":s3-libs",
    family = "mescc",
    ldflags = [
        "-nostdlib",
        "--base-address",
        "0x08048000",
    ],
    object_format = "mes",
    stage = "mes-s3",
)

[
    bootstrap_artifact(
        name = name,
        src = MES + src,
        abi = "x86_64-mes",
        kind = kind,
        object_format = "mes",
    )
    for name, src, kind in [
        ("mes-crt1", ":s3-crt1[crt1.o]", "object"),
        ("mes-libc", ":s3-libc+tcc.a", "library"),
        ("mes-support", ":s3-libmescc.a", "library"),
    ]
]

c_object(
    name = "seed.o",
    src = ":source[tcc.c]",
    defines = DEFINES + ["ONE_SOURCE=1"],
    headers = [":source"],
    includes = [":source"],
    object_name = "tcc.o",
    target_compatible_with = COMPAT,
    toolchain = ":mescc",
)

c_binary(
    name = "tcc-seed",
    libraries = [
        ":mes-libc",
        ":mes-support",
    ],
    objects = [
        ":mes-crt1",
        ":seed.o",
    ],
    output = "tcc",
    target_compatible_with = COMPAT,
    toolchain = ":mescc",
)

command_test(
    name = "seed-version",
    args = ["-version"],
    tool = ":tcc-seed",
)

[export_file(name = path) for path in glob(["patches/*"])]

# Conventional x86_64 headers are separate from the seed's Mes-ABI headers.
[
    exact_patch(
        name = name + ".h",
        src = MES + ":mes-src[include/" + name + ".h]",
        output = name + ".h",
        patch = ":patches/" + name + ".patch",
    )
    for name in [
        "stdarg",
        "setjmp",
    ]
]

filegroup(
    name = "headers",
    srcs = {
        path[8:]: MES + ":mes-src[{}]".format(path)
        for path in PREPARED_FILES
        if path.startswith("include/") and path not in [
            "include/stdarg.h",
            "include/setjmp.h",
        ]
    } | {
        "stdarg.h": ":stdarg.h",
        "setjmp.h": ":setjmp.h",
        "mes/config.h": MES + ":config.h",
        "arch/syscall.h": MES + ":mes-src[include/arch/syscall.h]",
        "arch/kernel-stat.h": MES + ":mes-src[include/arch/kernel-stat.h]",
        "arch/signal.h": MES + ":mes-src[include/arch/signal.h]",
    },
)

exact_patch(
    name = "buffered-read.c",
    src = MES + ":mes-src[lib/mes/__buffered_read.c]",
    output = "__buffered_read.c",
    patch = ":patches/read-bounds.patch",
)

exact_patch(
    name = "abtod.c",
    src = MES + ":mes-src[lib/mes/abtod.c]",
    output = "abtod.c",
    patch = ":patches/abtod.patch",
)

exact_patch(
    name = "runtime-support.c",
    src = ":tcc-0.9.26-1147-gee75a10c[lib/libtcc1.c]",
    output = "libtcc1.c",
    patch = ":patches/runtime-float.patch",
)

# Each runtime is emitted by its named compiler. Its execution runtime is an
# independent property; a compiler never depends on the runtime it is building.
RUNTIMES = [
    (
        "initial",
        ":tcc-seed",
        MES + ":s3-libs",
    ),
    ("boot0", ":tcc-boot0", ":runtime-initial"),
    ("boot1", ":tcc-boot1", ":runtime-boot0"),
    ("boot2", ":tcc-boot2", ":runtime-boot1"),
]

[
    compiler(
        name = stage + "-raw",
        abi = "x86_64-sysv",
        archive_flags = [
            "-ar",
            "cr",
        ],
        archive_format = "ar",
        archiver = cc,
        cflags = ["-nostdinc"],
        compiler = cc,
        execution_runtime = execution_runtime,
        family = "tcc",
        ldflags = [
            "-nostdlib",
            "-static",
        ],
        object_format = "elf64-x86-64",
        stage = stage,
        target_compatible_with = COMPAT,
    )
    for stage, cc, execution_runtime in RUNTIMES
]

[
    c_object(
        name = "{}-libc-{}.o".format(stage, i),
        src = {
            "lib/mes/__buffered_read.c": ":buffered-read.c",
            "lib/mes/abtod.c": ":abtod.c",
            "lib/stub/ldexp.c": "runtime/ldexp.c",
        }.get(
            path,
            MES + ":mes-src[{}]".format(path),
        ),
        defines = ["HAVE_CONFIG_H=1"],
        headers = [":headers"],
        includes = [
            ":headers",
            ":headers[linux/x86_64]",
        ],
        object_name = "r{}.o".format(i),
        toolchain = ":" + stage + "-raw",
    )
    for stage, _cc, _execution_runtime in RUNTIMES
    for i, path in enumerate(LIBC_SOURCES)
]

[
    c_object(
        name = "{}-{}.o".format(stage, name),
        src = src,
        defines = [
            "HAVE_CONFIG_H=1",
            "HAVE_LONG_LONG=1",
            "HAVE_FLOAT=1",
            "TCC_TARGET_X86_64=1",
        ],
        headers = [":headers"],
        includes = [
            ":headers",
            ":headers[linux/x86_64]",
        ],
        object_name = name + ".o",
        toolchain = ":" + stage + "-raw",
    )
    for stage, _cc, _execution_runtime in RUNTIMES
    for name, src in [
        ("crt1", "runtime/crt1.S"),
        ("crti", "runtime/empty.S"),
        ("crtn", "runtime/empty.S"),
        ("setjmp", "runtime/setjmp.S"),
        ("exit", "runtime/exit.S"),
        (
            "support",
            ":runtime-support.c",
        ),
        ("varargs", ":source[lib/va_list.c]"),
        ("alloca", ":source[lib/alloca86_64.S]"),
        (
            "getopt",
            MES + ":mes-src[lib/posix/getopt.c]",
        ),
    ]
]

[
    c_library(
        name = "{}-libc.a".format(stage),
        objects = [":{}-libc-{}.o".format(stage, i) for i in range(len(LIBC_SOURCES))] + [":{}-{}.o".format(stage, name) for name in [
            "setjmp",
            "exit",
        ]],
        output = "libc.a",
        toolchain = ":" + stage + "-raw",
    )
    for stage, _cc, _execution_runtime in RUNTIMES
]

[
    c_library(
        name = "{}-libtcc1.a".format(stage),
        objects = [":{}-{}.o".format(stage, name) for name in [
            "support",
            "varargs",
            "alloca",
        ]],
        output = "libtcc1.a",
        toolchain = ":" + stage + "-raw",
    )
    for stage, _cc, _execution_runtime in RUNTIMES
]

[
    c_library(
        name = "{}-libgetopt.a".format(stage),
        objects = [":{}-getopt.o".format(stage)],
        output = "libgetopt.a",
        toolchain = ":" + stage + "-raw",
    )
    for stage, _cc, _execution_runtime in RUNTIMES
]

[
    sysroot(
        name = "runtime-" + stage,
        abi = "x86_64-sysv",
        files = {"include": ":headers"},
        libraries = {"lib/" + name + ".a": ":{}-{}.a".format(stage, name) for name in [
            "libc",
            "libtcc1",
            "libgetopt",
        ]},
        object_format = "elf64-x86-64",
        objects = {"lib/" + name + ".o": ":{}-{}.o".format(stage, name) for name in [
            "crt1",
            "crti",
            "crtn",
        ]},
    )
    for stage, _cc, _execution_runtime in RUNTIMES
]

[
    compiler(
        name = stage + "-compiler",
        abi = "x86_64-sysv",
        archive_flags = [
            "-ar",
            "cr",
        ],
        archive_format = "ar",
        archiver = cc,
        cflags = [
            "-nostdinc",
            "-I",
            "$(location :headers)",
        ],
        compiler = cc,
        execution_runtime = execution_runtime,
        family = "tcc",
        ldflags = [
            "-nostdlib",
            "-static",
        ],
        object_format = "elf64-x86-64",
        stage = stage,
        sysroot = ":runtime-" + stage,
        target_compatible_with = COMPAT,
    )
    for stage, cc, execution_runtime in RUNTIMES
]

[
    c_object(
        name = "{}-abi-{}.o".format(stage, name),
        src = src,
        headers = [":headers"],
        object_name = name + ".o",
        toolchain = ":" + stage + "-compiler",
    )
    for stage in [
        "initial",
        "boot1",
        "boot2",
    ]
    for name, src in [
        ("main", "tests/abi.c"),
        ("probe", "tests/abi.S"),
    ]
]

[
    c_binary(
        name = stage + "-abi-program",
        libraries = [
            ":" + stage + "-libc.a",
            ":" + stage + "-libtcc1.a",
            ":" + stage + "-libc.a",
        ],
        objects = [
            ":" + stage + "-crt1.o",
            ":" + stage + "-abi-main.o",
            ":" + stage + "-abi-probe.o",
        ],
        toolchain = ":" + stage + "-compiler",
    )
    for stage in [
        "initial",
        "boot1",
        "boot2",
    ]
]

[
    command_test(
        name = stage + "-abi",
        args = [
            "startup",
            "ok",
        ],
        env = {"BOOTSTRAP_TEST": "present"},
        tool = ":" + stage + "-abi-program",
    )
    for stage in [
        "initial",
        "boot1",
        "boot2",
    ]
]

command_test(
    name = "seed-call",
    args = [
        "0",
        "$(exe :tcc-seed)",
        "-nostdinc",
        "-c",
        "$(location :tests/seed-call.c)",
        "-o",
        "/dev/null",
    ],
    tool = "cellar//bootstrap/stage1/tools:expect-exit",
)

export_file(name = "tests/seed-call.c")

c_object(
    name = "initial-exit-test.o",
    src = "tests/exit.c",
    object_name = "exit-test.o",
    toolchain = ":initial-compiler",
)

c_binary(
    name = "initial-exit-program",
    libraries = [
        ":initial-libc.a",
        ":initial-libtcc1.a",
        ":initial-libc.a",
    ],
    objects = [
        ":initial-crt1.o",
        ":initial-exit-test.o",
    ],
    toolchain = ":initial-compiler",
)

command_test(
    name = "initial-exit-status",
    args = [
        "37",
        "$(exe :initial-exit-program)",
    ],
    tool = "cellar//bootstrap/stage1/tools:expect-exit",
)

exact_patch(
    name = "native-tccgen.c",
    src = ":source[tccgen.c]",
    output = "tccgen.c",
    patch = ":patches/negative-zero.patch",
)

filegroup(
    name = "native-source",
    srcs = {path: ":source[{}]".format(path) for path in TCC_FILES} | {
        "tccgen.c": ":native-tccgen.c",
        "config.h": ":config.h",
    },
)

# Separate translation units from boot0 onward. These stages have identical
# feature definitions and stable short archive member names, without debug info.
STAGES = [
    ("boot0", "initial"),
    ("boot1", "boot0"),
    ("boot2", "boot1"),
]

[
    c_object(
        name = "{}-compiler-{}.o".format(stage, i),
        src = ":native-source[{}]".format(path),
        defines = DEFINES + [
            "HAVE_FLOAT=1",
            "HAVE_BITFIELD=1",
            "HAVE_SETJMP=1",
        ],
        headers = [
            ":native-source",
            ":headers",
        ],
        includes = [":native-source"],
        object_name = "t{}.o".format(i),
        toolchain = ":" + predecessor + "-compiler",
    )
    for stage, predecessor in STAGES
    for i, path in enumerate(["tcc.c"] + COMPILER_SOURCES)
]

[
    c_library(
        name = stage + "-libtcc.a",
        objects = [":{}-compiler-{}.o".format(
            stage,
            i + 1,
        ) for i in range(len(COMPILER_SOURCES))],
        output = "libtcc.a",
        toolchain = ":" + predecessor + "-compiler",
    )
    for stage, predecessor in STAGES
]

[
    c_binary(
        name = "tcc-" + stage,
        libraries = [
            ":" + stage + "-libtcc.a",
            ":" + predecessor + "-libc.a",
            ":" + predecessor + "-libtcc1.a",
            ":" + predecessor + "-libc.a",
        ],
        objects = [
            ":" + predecessor + "-crt1.o",
            ":" + stage + "-compiler-0.o",
        ],
        output = "tcc",
        toolchain = ":" + predecessor + "-compiler",
    )
    for stage, predecessor in STAGES
]

[
    command_test(
        name = stage + "-version",
        args = ["-version"],
        tool = ":tcc-" + stage,
    )
    for stage, _predecessor in STAGES
]

[
    c_object(
        name = "{}-features-{}.o".format(stage, name),
        src = src,
        headers = [":headers"],
        object_name = name + ".o",
        toolchain = ":" + stage + "-compiler",
    )
    for stage in [
        "boot1",
        "boot2",
    ]
    for name, src in [
        ("main", "tests/features.c"),
        ("archive", "tests/archive.c"),
        ("weak", "tests/weak.c"),
    ]
]

[
    c_library(
        name = stage + "-test-archive",
        objects = [":" + stage + "-features-archive.o"],
        output = "test.a",
        toolchain = ":" + stage + "-compiler",
    )
    for stage in [
        "boot1",
        "boot2",
    ]
]

[
    c_binary(
        name = stage + "-features-program",
        libraries = [
            ":" + stage + "-test-archive",
            ":" + stage + "-libc.a",
            ":" + stage + "-libtcc1.a",
            ":" + stage + "-libc.a",
        ],
        objects = [
            ":" + stage + "-crt1.o",
            ":" + stage + "-features-main.o",
            ":" + stage + "-features-weak.o",
        ],
        toolchain = ":" + stage + "-compiler",
    )
    for stage in [
        "boot1",
        "boot2",
    ]
]

[
    command_test(
        name = stage + "-features",
        tool = ":" + stage + "-features-program",
    )
    for stage in [
        "boot1",
        "boot2",
    ]
]

[
    command_test(
        name = stage + "-diagnostics",
        args = [
            "1",
            "$(exe :tcc-" + stage + ")",
            "-c",
            "$(location :tests/invalid.c)",
            "-o",
            "/dev/null",
        ],
        tool = "cellar//bootstrap/stage1/tools:expect-exit",
    )
    for stage in [
        "boot1",
        "boot2",
    ]
]

export_file(name = "tests/invalid.c")

filegroup(
    name = "empty-sysroot",
    srcs = {},
)

[export_file(name = "tests/" + name + ".c") for name in [
    "header",
    "link",
]]

[
    command_test(
        name = stage + "-missing-" + name,
        args = [
            "1",
            "$(exe :tcc-" + stage + ")",
            "-B",
            "$(location :empty-sysroot)",
        ] + flags + [
            "$(location :tests/" + name + ".c)",
            "-o",
            "/dev/null",
        ],
        tool = "cellar//bootstrap/stage1/tools:expect-exit",
    )
    for stage in [
        "boot1",
        "boot2",
    ]
    for name, flags in [
        (
            "header",
            ["-c"],
        ),
        (
            "link",
            ["-static"],
        ),
    ]
]

COMPARED = [
    ("tcc", ":tcc-boot1", ":tcc-boot2"),
    ("libtcc.a", ":boot1-libtcc.a", ":boot2-libtcc.a"),
] + [
    (
        name,
        ":boot1-" + name,
        ":boot2-" + name,
    )
    for name in [
        "crt1.o",
        "crti.o",
        "crtn.o",
        "libc.a",
        "libgetopt.a",
        "libtcc1.a",
    ]
]

[
    command_test(
        name = "compare-" + name,
        args = [
            "$(location " + left + ")",
            "$(location " + right + ")",
        ],
        tool = HELPERS + ":bytecmp",
    )
    for name, left, right in COMPARED
]

filegroup(
    name = "fixed-point",
    srcs = {},
    tests = [":compare-" + name for name, _left, _right in COMPARED],
)

compiler(
    name = "tcc",
    abi = "x86_64-sysv",
    archive_flags = [
        "-ar",
        "cr",
    ],
    archive_format = "ar",
    archiver = ":tcc-boot2",
    compiler = ":tcc-boot2",
    execution_runtime = ":runtime-boot1",
    family = "tcc",
    object_format = "elf64-x86-64",
    stage = "boot2",
    sysroot = ":runtime-boot2",
    target_compatible_with = COMPAT,
)

[
    c_object(
        name = "initial-" + name + "-test.o",
        src = "tests/" + name + ".c",
        object_name = name + ".o",
        toolchain = ":initial-compiler",
    )
    for name in [
        "integer",
        "strtod",
    ]
]

[
    c_binary(
        name = "initial-" + name + "-program",
        libraries = [
            ":initial-libc.a",
            ":initial-libtcc1.a",
            ":initial-libc.a",
        ],
        objects = [
            ":initial-crt1.o",
            ":initial-" + name + "-test.o",
        ],
        toolchain = ":initial-compiler",
    )
    for name in [
        "integer",
        "strtod",
    ]
]

[
    command_test(
        name = "initial-" + name,
        tool = ":initial-" + name + "-program",
    )
    for name in [
        "integer",
        "strtod",
    ]
]

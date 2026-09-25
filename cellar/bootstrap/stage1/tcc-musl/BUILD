# SPDX-FileCopyrightText: © 2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

load("@cellar//bootstrap:actions.bzl", "command_test", "generate")
load("@cellar//bootstrap:defs.bzl", "filegroup")
load("@cellar//bootstrap/stage1:defs.bzl", "c_binary", "c_library", "c_object", "compiler", "sysroot")
load("@cellar//bootstrap/stage1/tcc:sources.bzl", "COMPILER_SOURCES")

BOOT = "cellar//bootstrap/stage1/tcc"

RELEASE = "cellar//bootstrap/stage1/tcc-release"

MUSL = "cellar//bootstrap/stage1/musl"

COMPAT = [
    "cellar//bootstrap/platforms:linux",
    "cellar//bootstrap/platforms:amd64",
]

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

# Preserve both corrective passes: first link 0.9.27 with musl using the
# fixed-point 0.9.26, then let that musl-linked compiler rebuild itself.
[
    compiler(
        name = stage + "-predecessor",
        abi = "x86_64-sysv",
        archive_flags = [
            "-ar",
            "cr",
        ],
        archive_format = "ar",
        archive_member_name_limit = 15,
        archiver = predecessor,
        cflags = [
            "-nostdinc",
            "-I",
            "$(location " + MUSL + ":headers)",
        ],
        compiler = predecessor,
        execution_runtime = execution_runtime,
        family = "tcc",
        ldflags = [
            "-nostdlib",
            "-static",
        ],
        object_format = "elf64-x86-64",
        stage = stage,
        sysroot = output_sysroot,
        target_compatible_with = COMPAT,
    )
    for stage, predecessor, execution_runtime, output_sysroot in [
        (
            "musl0",
            BOOT + ":tcc-boot2",
            BOOT + ":runtime-boot1",
            MUSL + ":runtime-initial",
        ),
        (
            "musl1",
            ":tcc-musl0",
            MUSL + ":runtime-initial",
            ":runtime-musl0",
        ),
        (
            "musl2",
            ":tcc-musl1",
            MUSL + ":runtime-initial",
            MUSL + ":runtime-rebuilt",
        ),
    ]
]

[
    [
        [
            c_object(
                name = stage + "-compiler-{}.o".format(i),
                src = RELEASE + ":source[{}]".format(path),
                defines = DEFINES,
                headers = [
                    RELEASE + ":source",
                    MUSL + ":headers",
                ],
                includes = [RELEASE + ":source"],
                object_name = "t{}.o".format(i),
                toolchain = ":" + stage + "-predecessor",
            )
            for i, path in enumerate(["tcc.c"] + COMPILER_SOURCES)
        ],
        c_library(
            name = stage + "-libtcc.a",
            objects = [":" + stage + "-compiler-{}.o".format(i + 1) for i in range(len(COMPILER_SOURCES))],
            output = "libtcc.a",
            toolchain = ":" + stage + "-predecessor",
        ),
        c_binary(
            name = "tcc-" + stage,
            end_objects = [
                MUSL + ":" + libc_stage + "-crtn.o",
            ],
            libraries = [
                ":" + stage + "-libtcc.a",
                MUSL + ":" + libc_stage + "-libc.a",
                support_library,
                MUSL + ":" + libc_stage + "-libc.a",
            ],
            objects = [
                MUSL + ":" + libc_stage + "-crt1.o",
                MUSL + ":" + libc_stage + "-crti.o",
                ":" + stage + "-compiler-0.o",
            ],
            output = "tcc",
            toolchain = ":" + stage + "-predecessor",
        ),
        [
            c_object(
                name = stage + "-" + name + ".o",
                src = RELEASE + ":source[" + path + "]",
                defines = ["TCC_TARGET_X86_64=1"],
                headers = [MUSL + ":headers"],
                object_name = name + ".o",
                toolchain = ":" + stage + "-predecessor",
            )
            for name, path in [
                ("support", "lib/libtcc1.c"),
                ("varargs", "lib/va_list.c"),
                ("alloca", "lib/alloca86_64.S"),
            ]
        ],
        c_library(
            name = stage + "-libtcc1.a",
            objects = [":" + stage + "-" + name + ".o" for name in [
                "support",
                "varargs",
                "alloca",
            ]],
            output = "libtcc1.a",
            toolchain = ":" + stage + "-predecessor",
        ),
        sysroot(
            name = "runtime-" + stage,
            abi = "x86_64-sysv",
            files = {"include": MUSL + ":headers"},
            libraries = {"lib/lib" + name + ".a": MUSL + ":" + libc_stage + "-lib" + name + ".a" for name in [
                "c",
                "m",
                "rt",
                "pthread",
                "crypt",
                "util",
                "xnet",
                "resolv",
                "dl",
            ]} | {"lib/libtcc1.a": ":" + stage + "-libtcc1.a"},
            object_format = "elf64-x86-64",
            objects = {"lib/" + name + ".o": MUSL + ":" + libc_stage + "-" + name + ".o" for name in [
                "crt1",
                "crti",
                "crtn",
            ]},
        ),
        compiler(
            name = stage,
            abi = "x86_64-sysv",
            archive_flags = [
                "-ar",
                "cr",
            ],
            archive_format = "ar",
            archive_member_name_limit = 15,
            archiver = ":tcc-" + stage,
            cflags = [
                "-nostdinc",
                "-I",
                "$(location " + MUSL + ":headers)",
            ],
            compiler = ":tcc-" + stage,
            execution_runtime = MUSL + ":runtime-" + libc_stage,
            family = "tcc",
            ldflags = [
                "-nostdlib",
                "-static",
            ],
            object_format = "elf64-x86-64",
            stage = stage,
            sysroot = ":runtime-" + stage,
            target_compatible_with = COMPAT,
        ),
        generate(
            name = stage + "-driver-program",
            args = [
                "$(location " + MUSL + ":test-source[tests/runtime.c])",
                "-o",
            ],
            output = "driver-program",
            tool = ":" + stage,
        ),
        command_test(
            name = stage + "-driver",
            args = [
                "0",
                "$(location :" + stage + "-driver-program)",
                "startup",
                "ok",
            ],
            env = {"BOOTSTRAP_TEST": "present"},
            tool = "cellar//bootstrap/stage1/tools:expect-exit",
        ),
        command_test(
            name = stage + "-version",
            args = ["-version"],
            tool = ":tcc-" + stage,
        ),
        [
            [
                c_object(
                    name = stage + "-" + name + "-test.o",
                    src = MUSL + ":test-source[tests/" + name + ".c]",
                    headers = [MUSL + ":headers"],
                    object_name = name + ".o",
                    toolchain = ":" + stage,
                ),
                c_binary(
                    name = stage + "-" + name + "-program",
                    end_objects = [
                        MUSL + ":" + libc_stage + "-crtn.o",
                    ],
                    libraries = [
                        MUSL + ":" + libc_stage + "-libc.a",
                        ":" + stage + "-libtcc1.a",
                        MUSL + ":" + libc_stage + "-libc.a",
                    ],
                    objects = [
                        MUSL + ":" + libc_stage + "-crt1.o",
                        MUSL + ":" + libc_stage + "-crti.o",
                        ":" + stage + "-" + name + "-test.o",
                    ],
                    toolchain = ":" + stage,
                ),
                command_test(
                    name = stage + "-" + name,
                    args = [
                        "startup",
                        "ok",
                    ] if name == "runtime" else [],
                    env = {"BOOTSTRAP_TEST": "present"},
                    tool = ":" + stage + "-" + name + "-program",
                ),
            ]
            for name in [
                "headers",
                "runtime",
                "threads",
                "fenv",
                "syscalls",
            ]
        ],
    ]
    for stage, support_library, libc_stage in [
        (
            "musl0",
            RELEASE + ":mes1-libtcc1.a",
            "initial",
        ),
        ("musl1", ":musl0-libtcc1.a", "initial"),
        ("musl2", ":musl1-libtcc1.a", "rebuilt"),
    ]
]

filegroup(
    name = "all",
    srcs = {
        "bin/tcc": ":tcc-musl2",
        "sysroot": ":runtime-musl2",
    },
)

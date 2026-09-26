# SPDX-FileCopyrightText: © 2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

load("@cellar//bootstrap:actions.bzl", "command_test")
load("@cellar//bootstrap/stage1:defs.bzl", "c_binary", "c_library", "c_object")
load("@cellar//bootstrap/stage1/tcc:sources.bzl", "COMPILER_SOURCES")

RELEASE = "cellar//bootstrap/stage1/tcc-release"

BOOT = "cellar//bootstrap/stage1/tcc"

# The configuration of every TCC 0.9.27 build: full release features and a
# static native compiler that finds headers, CRT objects and libraries under
# the sysroot its toolchain passes with -B. `elfinterp` names the dynamic
# loader of the target C library.
def release_defines(elfinterp):
    return [
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
        'CONFIG_TCC_ELFINTERP="{}"'.format(elfinterp),
    ]

# Compiles TCC 0.9.27 one translation unit at a time as `<name>-compiler-<i>.o`,
# archives all but tcc.c as `<name>-libtcc.a`, and links `tcc-<name>`.
# `sources` replaces release sources by path.
def release_tcc(name, toolchain, runtime, defines, headers, includes, flags = [], sources = {}, extra_objects = [], link_flags = []):
    units = ["tcc.c"] + COMPILER_SOURCES
    for i, path in enumerate(units):
        c_object(
            name = "{}-compiler-{}.o".format(name, i),
            src = sources.get(path, RELEASE + ":source[{}]".format(path)),
            defines = defines,
            flags = flags,
            headers = headers,
            includes = includes,
            object_name = "t{}.o".format(i),
            toolchain = toolchain,
        )
    c_library(
        name = name + "-libtcc.a",
        objects = [":{}-compiler-{}.o".format(name, i) for i in range(1, len(units))],
        output = "libtcc.a",
        toolchain = toolchain,
    )
    c_binary(
        name = "tcc-" + name,
        flags = link_flags,
        libraries = [":" + name + "-libtcc.a"],
        objects = [":" + name + "-compiler-0.o"] + extra_objects,
        output = "tcc",
        runtime = runtime,
        toolchain = toolchain,
    )

LIBTCC1_SOURCES = [
    ("support", "lib/libtcc1.c"),
    ("varargs", "lib/va_list.c"),
    ("alloca", "lib/alloca86_64.S"),
]

# TCC's own support library, `<name>-libtcc1.a`, which every program it links
# needs for varargs, alloca and integer and floating conversions.
def release_libtcc1(name, toolchain, headers = []):
    for obj, path in LIBTCC1_SOURCES:
        c_object(
            name = name + "-" + obj + ".o",
            src = RELEASE + ":source[" + path + "]",
            defines = ["TCC_TARGET_X86_64=1"],
            headers = headers,
            object_name = obj + ".o",
            toolchain = toolchain,
        )
    c_library(
        name = name + "-libtcc1.a",
        objects = [":" + name + "-" + obj + ".o" for obj, _path in LIBTCC1_SOURCES],
        output = "libtcc1.a",
        toolchain = toolchain,
    )

TEST_SOURCES = [
    ("abi", BOOT + ":test-source[tests/abi.c]"),
    ("probe", BOOT + ":test-source[tests/abi.S]"),
    ("integer", BOOT + ":test-source[tests/integer.c]"),
    ("features", BOOT + ":test-source[tests/features.c]"),
    ("archive", BOOT + ":test-source[tests/archive.c]"),
    ("weak", BOOT + ":test-source[tests/weak.c]"),
    ("weak-only", RELEASE + ":tests/weak-only.c"),
    ("array", RELEASE + ":tests/array.c"),
]

TEST_ARCHIVES = [
    "archive",
    "weak-only",
]

# Program name, objects and archives. `array` links a weak-only archive member.
TEST_PROGRAMS = [
    ("abi", ["abi", "probe"], []),
    ("integer", ["integer"], []),
    ("features", ["features", "weak"], ["archive"]),
    ("array", ["array"], ["weak-only"]),
]

# Compiles the release acceptance programs' objects and archives with one
# compiler, as `<name>-test-<object>.o` and `<name>-test-<archive>.a`.
def release_test_objects(name, toolchain):
    for obj, src in TEST_SOURCES:
        c_object(
            name = name + "-test-" + obj + ".o",
            src = src,
            headers = [BOOT + ":headers"],
            object_name = obj + ".o",
            toolchain = toolchain,
        )
    for archive in TEST_ARCHIVES:
        c_library(
            name = name + "-test-" + archive + ".a",
            objects = [":" + name + "-test-" + archive + ".o"],
            output = archive + ".a",
            toolchain = toolchain,
        )

# Links the objects from `release_test_objects(objects)` against `runtime` and
# runs them: the native ABI with startup arguments and environment, integer and
# floating arithmetic, mixed varargs, archives, weak symbols and C99 array
# parameters.
def release_test_programs(name, objects, toolchain, runtime):
    for program, program_objects, archives in TEST_PROGRAMS:
        c_binary(
            name = name + "-" + program + "-program",
            libraries = [":" + objects + "-test-" + archive + ".a" for archive in archives],
            objects = [":" + objects + "-test-" + obj + ".o" for obj in program_objects],
            runtime = runtime,
            toolchain = toolchain,
        )
    command_test(
        name = name + "-abi",
        args = [
            "startup",
            "ok",
        ],
        env = {"BOOTSTRAP_TEST": "present"},
        tool = ":" + name + "-abi-program",
    )
    for program, _objects, _archives in TEST_PROGRAMS[1:]:
        command_test(
            name = name + "-" + program,
            tool = ":" + name + "-" + program + "-program",
        )

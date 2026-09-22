# SPDX-FileCopyrightText: 2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

load("@cellar//bootstrap:actions.bzl", "command_test", "generate")
load("@cellar//bootstrap:defs.bzl", "filegroup")
load("@cellar//bootstrap:source.bzl", "download_file", "ungz", "untar", "write_file")
load("@cellar//bootstrap/stage1:defs.bzl", "c_binary", "c_library", "c_object")
load(":sources.bzl", "LIBRARY_SOURCES", "SOURCE_FILES", "TESTS", "TEST_SUPPORT")

GCC = "cellar//bootstrap/stage1/gcc40-rebuilt"

MUSL = "cellar//bootstrap/stage1/musl12"

GMP = "cellar//bootstrap/stage1/gmp"

MPFR = "cellar//bootstrap/stage1/mpfr"

CC = GCC + ":gcc"

CRT = [
    MUSL + ":crt1.o",
    MUSL + ":crti.o",
    GCC + ":crtbeginT.o",
]

CRTN = [
    GCC + ":crtend.o",
    MUSL + ":crtn.o",
]

LIBC = [
    MUSL + ":libc.a",
    GCC + ":libgcc.a",
    MUSL + ":libc.a",
]

# Reviewed GNU C99/GCC 4.0.4, native x86_64 with full musl and C complex types.
CONFIG = {
    "HAVE_COMPLEX_H": "1",
    "HAVE_DUP": "1",
    "HAVE_DUP2": "1",
    "HAVE_GETRUSAGE": "1",
    "HAVE_GETTIMEOFDAY": "1",
    "HAVE_INTPTR_T": "1",
    "HAVE_INTTYPES_H": "1",
    "HAVE_LIMITS_H": "1",
    "HAVE_LOCALECONV": "1",
    "HAVE_LOCALE_H": "1",
    "HAVE_MEMORY_H": "1",
    "HAVE_SETLOCALE": "1",
    "HAVE_STDINT_H": "1",
    "HAVE_STDLIB_H": "1",
    "HAVE_STRINGS_H": "1",
    "HAVE_STRING_H": "1",
    "HAVE_SYS_RESOURCE_H": "1",
    "HAVE_SYS_STAT_H": "1",
    "HAVE_SYS_TIME_H": "1",
    "HAVE_SYS_TYPES_H": "1",
    "HAVE_UNISTD_H": "1",
    "MPC_CC": '"gcc"',
    "MPC_GCC": '"yes"',
    "MPC_GCC_VERSION": '"4.0.4"',
    "PACKAGE": '"mpc"',
    "PACKAGE_NAME": '"MPC"',
    "PACKAGE_STRING": '"MPC 1.2.1"',
    "PACKAGE_TARNAME": '"mpc"',
    "PACKAGE_VERSION": '"1.2.1"',
    "VERSION": '"1.2.1"',
    "STDC_HEADERS": "1",
    "TIME_WITH_SYS_TIME": "1",
}

download_file(
    name = "mpc-1.2.1.tar.gz",
    hash = "17503d2c395dfcf106b622dc142683c1199431d095367c6aacba6eec30340459",
    size_bytes = 838731,
    urls = ["https://mirrors.kernel.org/gnu/mpc/mpc-1.2.1.tar.gz"],
)

ungz(
    name = "mpc.tar",
    input = ":mpc-1.2.1.tar.gz",
    ungz = "cellar//bootstrap/stage0-posix/mescc-tools-extra:ungz",
)

untar(
    name = "mpc-1.2.1",
    chdirenv = "cellar//bootstrap/stage0-posix/cellar-extra:chdirenv",
    files = SOURCE_FILES + ["COPYING.LESSER"],
    input = ":mpc.tar",
    untar = "cellar//bootstrap/stage0-posix/mescc-tools-extra:untar",
)

filegroup(
    name = "source",
    srcs = {p: ":mpc-1.2.1[" + p + "]" for p in SOURCE_FILES},
)

write_file(
    name = "config.h",
    content = "/* Reviewed native GCC 4.0.4 / musl 1.2.5 configuration. */\n" +
              "\n".join(["#define " + k + " " + v for k, v in CONFIG.items()]) + "\n",
)

filegroup(
    name = "config",
    srcs = {"config.h": ":config.h"},
)

INCLUDES = [
    ":config",
    ":source[src]",
    MPFR + ":headers",
    GMP + ":headers",
]

FLAGS = [
    "-O2",
    "-std=gnu99",
    "-Werror",
    "-fno-strict-aliasing",
]

[
    c_object(
        name = "lib-" + str(i) + ".o",
        src = ":source[" + p + "]",
        defines = ["HAVE_CONFIG_H=1"],
        flags = FLAGS,
        headers = INCLUDES,
        includes = INCLUDES,
        object_name = "m" + str(i) + ".o",
        toolchain = CC,
    )
    for i, p in enumerate(LIBRARY_SOURCES)
]

c_library(
    name = "libmpc.a",
    objects = [":lib-" + str(i) + ".o" for i in range(len(LIBRARY_SOURCES))],
    output = "libmpc.a",
    toolchain = CC,
)

[
    c_object(
        name = "support-" + str(i) + ".o",
        src = ":source[" + p + "]",
        defines = ["HAVE_CONFIG_H=1"],
        flags = FLAGS,
        headers = INCLUDES + [":source[tests]"],
        includes = INCLUDES + [":source[tests]"],
        object_name = "s" + str(i) + ".o",
        toolchain = CC,
    )
    for i, p in enumerate(TEST_SUPPORT)
]

c_library(
    name = "libtests.a",
    objects = [":support-" + str(i) + ".o" for i in range(len(TEST_SUPPORT))],
    output = "libtests.a",
    toolchain = CC,
)

TEST_ENV = {
    "GMP_CHECK_RANDOMIZE": "42",
    "srcdir": "$(location :source[tests])",
}

[
    [
        c_object(
            name = "test-" + name + ".o",
            src = ":source[tests/" + name + ".c]",
            defines = ["HAVE_CONFIG_H=1"],
            flags = FLAGS,
            headers = INCLUDES + [":source[tests]"],
            includes = INCLUDES + [":source[tests]"],
            toolchain = CC,
        ),
        c_binary(
            name = "test-" + name + "-program",
            libraries = [
                ":libtests.a",
                ":libmpc.a",
                MPFR + ":libmpfr.a",
                GMP + ":libgmp.a",
            ] + LIBC,
            objects = CRT + [":test-" + name + ".o"] + CRTN,
            toolchain = CC,
        ),
        generate(
            name = name + "-scratch",
            args = [
                "stdout",
                "$(location :test-" + name + "-program)",
            ],
            chdir = "cellar//bootstrap/stage0-posix/cellar-extra:chdirenv",
            directory = True,
            env = TEST_ENV,
            files = ["stdout"],
            tool = "cellar//bootstrap/stage1/tools:capture",
        ) if name == "tio_str" else None,
        command_test(
            name = name,
            args = [
                "$(location :" + name + "-scratch[stdout])",
                "$(location :expected-seed-output)",
            ],
            tool = "cellar//bootstrap/stage0-posix/cellar-extra:bytecmp",
        ) if name == "tio_str" else command_test(
            name = name,
            env = TEST_ENV,
            tool = ":test-" + name + "-program",
        ),
    ]
    for name in TESTS
]

write_file(
    name = "expected-seed-output",
    content = "Re-seeding with GMP_CHECK_RANDOMIZE=42\n",
)

filegroup(
    name = "headers",
    srcs = {"mpc.h": ":source[src/mpc.h]"},
)

filegroup(
    name = "installation",
    srcs = {
        "include/mpc.h": ":source[src/mpc.h]",
        "lib/libmpc.a": ":libmpc.a",
        "share/licenses/mpc/COPYING.LESSER": ":mpc-1.2.1[COPYING.LESSER]",
    },
)

# SPDX-FileCopyrightText: 2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

load("@cellar//bootstrap:actions.bzl", "command_test", "generate")
load("@cellar//bootstrap:defs.bzl", "filegroup")
load("@cellar//bootstrap:source.bzl", "download_file", "untar", "write_file")
load("@cellar//bootstrap/stage1:defs.bzl", "c_binary", "c_library", "c_object")
load(":sources.bzl", "LIBRARY_SOURCES", "SOURCE_FILES", "TESTS", "TEST_SUPPORT")

GCC = "cellar//bootstrap/stage1/gcc40-rebuilt"

MUSL = "cellar//bootstrap/stage1/musl12"

GMP = "cellar//bootstrap/stage1/gmp"

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

# Native LP64/SysV, IEEE binary32/binary64 and x87 extended long double.
# GCC 4.0 has GNU TLS and constructors, but no C11 or float128/decimal types.
CONFIG = {
    "MPFR_GENERIC_ABI": "1",
    "MPFR_TUNE_CASE": '"generic"',
    "NO_ASM": "1",
    "MPFR_USE_THREAD_SAFE": "1",
    "MPFR_HAVE_CONSTRUCTOR_ATTR": "1",
    "MPFR_HAVE_INTMAX_MAX": "1",
    "MPFR_LONG_WITHIN_LIMB": "1",
    "MPFR_INTMAX_WITHIN_LIMB": "1",
    "MPFR_HAVE_FESETROUND": "1",
    "HAVE_PTHREAD": "1",
    "HAVE_LITTLE_ENDIAN": "1",
    "HAVE_DOUBLE_IEEE_LITTLE_ENDIAN": "1",
    "HAVE_LDOUBLE_IEEE_EXT_LITTLE": "1",
    "HAVE_SUBNORM_DBL": "1",
    "HAVE_SUBNORM_FLT": "1",
    "HAVE_SIGNEDZ": "1",
    "HAVE_ATTRIBUTE_MODE": "1",
    "HAVE_ALLOCA": "1",
    "HAVE_ALLOCA_H": "1",
    "HAVE_LOCALE_H": "1",
    "HAVE_WCHAR_H": "1",
    "HAVE_STDARG": "1",
    "HAVE_VA_COPY": "1",
    "HAVE_SYS_TIME_H": "1",
    "HAVE_STRUCT_LCONV_DECIMAL_POINT": "1",
    "HAVE_STRUCT_LCONV_THOUSANDS_SEP": "1",
    "HAVE_SETLOCALE": "1",
    "HAVE_GETTIMEOFDAY": "1",
    "HAVE_SIGNAL": "1",
    "HAVE_SIGACTION": "1",
    "HAVE_LONG_LONG": "1",
    "HAVE_INTMAX_T": "1",
    "HAVE_STDINT_H": "1",
    "HAVE_INTTYPES_H": "1",
    "HAVE_ROUND": "1",
    "HAVE_TRUNC": "1",
    "HAVE_FLOOR": "1",
    "HAVE_CEIL": "1",
    "HAVE_NEARBYINT": "1",
    "HAVE_CLOCK_GETTIME": "1",
    "TIME_WITH_SYS_TIME": "1",
    "PRINTF_L": "1",
    "PRINTF_T": "1",
    "PRINTF_GROUPFLAG": "1",
}

download_file(
    name = "mpfr-4.1.0.tar.xz",
    hash = "0c98a3f1732ff6ca4ea690552079da9c597872d30e96ec28414ee23c95558a7f",
    size_bytes = 1525476,
    urls = ["https://mirrors.kernel.org/gnu/mpfr/mpfr-4.1.0.tar.xz"],
)

generate(
    name = "mpfr.tar",
    args = [
        "--file",
        "$(location :mpfr-4.1.0.tar.xz)",
        "--output",
    ],
    tool = "cellar//bootstrap/stage0-posix/mescc-tools-extra:unxz",
)

untar(
    name = "mpfr-4.1.0",
    chdirenv = "cellar//bootstrap/stage0-posix/cellar-extra:chdirenv",
    files = SOURCE_FILES + [
        "COPYING",
        "COPYING.LESSER",
    ],
    input = ":mpfr.tar",
    untar = "cellar//bootstrap/stage0-posix/mescc-tools-extra:untar",
)

# Test fixtures are passed explicitly at execution time, not compiled workspace paths.
write_file(
    name = "srcdir.before",
    content = "  const char *srcdir = SRCDIR;",
)

write_file(
    name = "srcdir.after",
    content = "  const char *srcdir = getenv (\"MPFR_TEST_SRCDIR\");\n  if (srcdir == NULL) abort ();",
)

generate(
    name = "tests.c",
    args = [
        "$(location :mpfr-4.1.0[tests/tests.c])",
        "$(location :srcdir.before)",
        "$(location :srcdir.after)",
    ],
    output = "tests.c",
    tool = "cellar//bootstrap/stage1/simple-patch:simple-patch",
)

filegroup(
    name = "source",
    srcs = {p: ":mpfr-4.1.0[" + p + "]" for p in SOURCE_FILES if p != "tests/tests.c"} | {"tests/tests.c": ":tests.c"},
)

write_file(
    name = "config.h",
    content = "/* Reviewed GCC 4.0.4 / musl 1.2.5 / x86_64 configuration. */\n" +
              "\n".join(["#define " + k + " " + v for k, v in CONFIG.items()]) + "\n",
)

filegroup(
    name = "config",
    srcs = {
        "config.h": ":config.h",
        "mparam.h": ":source[src/generic/mparam.h]",
    },
)

filegroup(
    name = "generator-tools",
    srcs = {"cat": "cellar//bootstrap/stage1/coreutils:cat"},
)

# This is the upstream per-source generator, executed by bootstrapped Bash/cat.
generate(
    name = "patches-source",
    args = [
        "get_patches.c",
        "$(location cellar//bootstrap/stage1/bash-bootstrap:bash)",
        "$(location :source[tools/get_patches.sh])",
        "$(location :source[PATCHES])",
    ],
    chdir = "cellar//bootstrap/stage0-posix/cellar-extra:chdirenv",
    directory = True,
    env = {
        "PATH": "$(location :generator-tools)",
        "TMPDIR": ".",
    },
    files = ["get_patches.c"],
    tool = "cellar//bootstrap/stage1/tools:capture",
)

INCLUDES = [
    ":config",
    ":source[src]",
    GMP + ":headers",
]

FLAGS = [
    # Upstream configure normally supplies these definitions on the command
    # line. Force the map in before tests that inspect macros before includes.
    "-include",
    "$(location :config.h)",
    "-std=gnu99",
    "-O2",
    "-Werror",
    "-fno-strict-aliasing",
]

[
    c_object(
        name = "lib-" + str(i) + ".o",
        src = ":source[" + p + "]",
        defines = ["HAVE_CONFIG_H=1"],
        # GCC 4.0 warns about an intentional range guard when an unsigned int
        # is compared with INTMAX_MAX on LP64; retain upstream's guard.
        flags = FLAGS + (["-Wno-error"] if p == "src/vasprintf.c" else []),
        headers = INCLUDES,
        includes = INCLUDES,
        object_name = "m" + str(i) + ".o",
        toolchain = CC,
    )
    for i, p in enumerate(LIBRARY_SOURCES)
]

c_object(
    name = "get_patches.o",
    src = ":patches-source[get_patches.c]",
    defines = ["HAVE_CONFIG_H=1"],
    flags = FLAGS,
    headers = INCLUDES,
    includes = INCLUDES,
    object_name = "get_patches.o",
    toolchain = CC,
)

c_library(
    name = "libmpfr.a",
    objects = [":lib-" + str(i) + ".o" for i in range(len(LIBRARY_SOURCES))] + [":get_patches.o"],
    output = "libmpfr.a",
    toolchain = CC,
)

[
    c_object(
        name = "support-" + str(i) + ".o",
        src = ":source[" + p + "]",
        defines = [
            "HAVE_CONFIG_H=1",
            "SRCDIR=1",
        ],
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
                ":libmpfr.a",
                GMP + ":libgmp.a",
            ] + LIBC,
            objects = CRT + [":test-" + name + ".o"] + CRTN,
            toolchain = CC,
        ),
        command_test(
            name = name,
            env = {
                "GMP_CHECK_RANDOMIZE": "42",
                "MPFR_QUIET": "1",
                "MPFR_TEST_SRCDIR": "$(location :source[tests])",
            },
            tool = ":test-" + name + "-program",
        ),
    ]
    for name in TESTS
]

filegroup(
    name = "headers",
    srcs = {
        "mpfr.h": ":source[src/mpfr.h]",
        "mpf2mpfr.h": ":source[src/mpf2mpfr.h]",
    },
)

filegroup(
    name = "installation",
    srcs = {
        "include/mpfr.h": ":source[src/mpfr.h]",
        "include/mpf2mpfr.h": ":source[src/mpf2mpfr.h]",
        "lib/libmpfr.a": ":libmpfr.a",
        "share/licenses/mpfr/COPYING": ":mpfr-4.1.0[COPYING]",
        "share/licenses/mpfr/COPYING.LESSER": ":mpfr-4.1.0[COPYING.LESSER]",
    },
)

c_object(
    name = "threads.o",
    src = "tests/threads.c",
    flags = FLAGS,
    headers = INCLUDES,
    includes = INCLUDES,
    toolchain = CC,
)

c_binary(
    name = "threads-program",
    libraries = [
        ":libmpfr.a",
        GMP + ":libgmp.a",
    ] + LIBC,
    objects = CRT + [":threads.o"] + CRTN,
    toolchain = CC,
)

command_test(
    name = "threads",
    tool = ":threads-program",
)

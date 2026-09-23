# SPDX-FileCopyrightText: 2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

load("@cellar//bootstrap:actions.bzl", "command_test", "generate")
load("@cellar//bootstrap:defs.bzl", "filegroup")
load("@cellar//bootstrap:source.bzl", "download_file", "untar", "write_file")
load("@cellar//bootstrap/stage1:defs.bzl", "c_binary", "c_library", "c_object")
load(":sources.bzl", "API_SOURCES", "BASE_SOURCES", "MPN_SOURCES", "SOURCE_FILES", "TESTS", "TEST_SUPPORT")

GCC = "cellar//bootstrap/stage1/gcc40-rebuilt"

MUSL = "cellar//bootstrap/stage1/musl12"

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

# Fixed LP64, little-endian SysV ABI, generic C algorithms and no inline asm.
# Reentrant temporary allocations and upstream generic tuning thresholds.
CONFIG = {
    "GMP_LIMB_BITS": "64",
    "GMP_NAIL_BITS": "0",
    "GMP_MPARAM_H_SUGGEST": '\"mpn/generic/gmp-mparam.h\"',
    "NO_ASM": "1",
    "WANT_FFT": "1",
    "WANT_TMP_REENTRANT": "1",
    "SIZEOF_MP_LIMB_T": "8",
    "SIZEOF_UNSIGNED": "4",
    "SIZEOF_UNSIGNED_LONG": "8",
    "SIZEOF_UNSIGNED_SHORT": "2",
    "SIZEOF_VOID_P": "8",
    "HAVE_DOUBLE_IEEE_LITTLE_ENDIAN": "1",
    "HAVE_LIMB_LITTLE_ENDIAN": "1",
    "HAVE_HOST_CPU_FAMILY_x86_64": "1",
    "HAVE_DECL_SYS_ERRLIST": "0",
    "HAVE_DECL_SYS_NERR": "0",
    "RETSIGTYPE": "void",
    "PACKAGE": '\"gmp\"',
    "VERSION": '\"6.2.1\"',
    "STDC_HEADERS": "1",
    "TIME_WITH_SYS_TIME": "1",
}

FEATURES = [
    "ALARM",
    "ALLOCA",
    "ALLOCA_H",
    "ATTRIBUTE_CONST",
    "ATTRIBUTE_MALLOC",
    "ATTRIBUTE_MODE",
    "ATTRIBUTE_NORETURN",
    "CLOCK",
    "CLOCK_GETTIME",
    "DECL_FGETC",
    "DECL_FSCANF",
    "DECL_OPTARG",
    "DECL_UNGETC",
    "DECL_VFPRINTF",
    "FCNTL_H",
    "FLOAT_H",
    "GETPAGESIZE",
    "GETRUSAGE",
    "GETTIMEOFDAY",
    "HIDDEN_ALIAS",
    "INTMAX_T",
    "INTPTR_T",
    "INTTYPES_H",
    "LANGINFO_H",
    "LOCALECONV",
    "LOCALE_H",
    "LONG_DOUBLE",
    "LONG_LONG",
    "MEMORY_H",
    "MEMSET",
    "MMAP",
    "MPROTECT",
    "NL_LANGINFO",
    "NL_TYPES_H",
    "POPEN",
    "PTRDIFF_T",
    "RAISE",
    "SIGACTION",
    "SIGALTSTACK",
    "STACK_T",
    "STDINT_H",
    "STDLIB_H",
    "STRCHR",
    "STRERROR",
    "STRINGS_H",
    "STRING_H",
    "STRNLEN",
    "STRTOL",
    "STRTOUL",
    "SYSCONF",
    "SYS_MMAN_H",
    "SYS_PARAM_H",
    "SYS_RESOURCE_H",
    "SYS_STAT_H",
    "SYS_SYSINFO_H",
    "SYS_TIMES_H",
    "SYS_TIME_H",
    "SYS_TYPES_H",
    "TIMES",
    "UINT_LEAST32_T",
    "UNISTD_H",
    "VSNPRINTF",
]

download_file(
    name = "gmp-6.2.1.tar.xz",
    hash = "fd4829912cddd12f84181c3451cc752be224643e87fac497b69edddadc49b4f2",
    size_bytes = 2027316,
    urls = ["https://mirrors.kernel.org/gnu/gmp/gmp-6.2.1.tar.xz"],
)

generate(
    name = "gmp.tar",
    args = [
        "--file",
        "$(location :gmp-6.2.1.tar.xz)",
        "--output",
    ],
    tool = "cellar//bootstrap/stage0-posix/mescc-tools-extra:unxz",
)

untar(
    name = "gmp-6.2.1",
    chdirenv = "cellar//bootstrap/stage0-posix/cellar-extra:chdirenv",
    files = SOURCE_FILES + [
        "COPYING",
        "COPYING.LESSERv3",
        "COPYINGv2",
        "COPYINGv3",
    ],
    input = ":gmp.tar",
    untar = "cellar//bootstrap/stage0-posix/mescc-tools-extra:untar",
)

filegroup(
    name = "source",
    srcs = {p: ":gmp-6.2.1[" + p + "]" for p in SOURCE_FILES},
)

write_file(
    name = "config.h",
    content = "/* Reviewed GCC 4.0.4 / musl 1.2.5 / native x86_64 configuration. */\n" +
              "\n".join(["#define " + k + " " + v for k, v in CONFIG.items()]) + "\n" +
              "\n".join(["#define HAVE_" + f + " 1" for f in FEATURES]) + "\n",
)

GMP_HEADER = {
    "HAVE_HOST_CPU_FAMILY_power": "0",
    "HAVE_HOST_CPU_FAMILY_powerpc": "0",
    "GMP_LIMB_BITS": "64",
    "GMP_NAIL_BITS": "0",
    "DEFN_LONG_LONG_LIMB": "",
    "LIBGMP_DLL": "0",
    "CC": "gcc",
    "CFLAGS": "-O2 -g0 -fno-strict-aliasing",
}

generate(
    name = "gmp.h",
    args = [item for key, value in GMP_HEADER.items() for item in [
        "-e",
        "s|@" + key + "@|" + value + "|g",
    ]] + ["$(location :source[gmp-h.in])"],
    capture = "cellar//bootstrap/stage1/tools:capture",
    tool = "cellar//bootstrap/stage1/sed:sed",
)

GENERATORS = [
    "fac",
    "fib",
    "bases",
    "trialdivtab",
    "jacobitab",
    "psqr",
]

[
    [
        c_object(
            name = "gen-" + name + ".o",
            src = ":source[gen-" + name + ".c]",
            flags = [
                "-O2",
                "-Werror",
                "-fno-strict-aliasing",
            ],
            headers = [":source"],
            includes = [":source"],
            toolchain = CC,
        ),
        c_binary(
            name = "gen-" + name,
            end_objects = CRTN,
            libraries = LIBC,
            objects = CRT + [":gen-" + name + ".o"],
            output = "gen-" + name,
            toolchain = CC,
        ),
    ]
    for name in GENERATORS
]

TABLES = {
    "fac_table.h": (
        "fac",
        [
            "64",
            "0",
        ],
    ),
    "fib_table.h": (
        "fib",
        [
            "header",
            "64",
            "0",
        ],
    ),
    "fib_table.c": (
        "fib",
        [
            "table",
            "64",
            "0",
        ],
    ),
    "mp_bases.h": (
        "bases",
        [
            "header",
            "64",
            "0",
        ],
    ),
    "mp_bases.c": (
        "bases",
        [
            "table",
            "64",
            "0",
        ],
    ),
    "trialdivtab.h": (
        "trialdivtab",
        [
            "64",
            "8000",
        ],
    ),
    "jacobitab.h": ("jacobitab", []),
    "perfsqr.h": (
        "psqr",
        [
            "64",
            "0",
        ],
    ),
}

[
    generate(
        name = output,
        args = args,
        capture = "cellar//bootstrap/stage1/tools:capture",
        output = output,
        tool = ":gen-" + generator,
    )
    for output, (generator, args) in TABLES.items()
]

filegroup(
    name = "generated",
    srcs = {name: ":" + name for name in TABLES} | {
        "config.h": ":config.h",
        "gmp.h": ":gmp.h",
        "gmp-mparam.h": ":source[mpn/generic/gmp-mparam.h]",
        "mpn/perfsqr.h": ":perfsqr.h",
    },
)

INCLUDES = [
    ":generated",
    ":source",
]

FLAGS = [
    "-O2",
    "-Werror",
    "-fno-strict-aliasing",
]

# Numeric archive names are unique even under the early 15-character limit.
C_SOURCES = BASE_SOURCES + [p for sources in API_SOURCES.values() for p in sources]

[
    c_object(
        name = "api-" + str(i) + ".o",
        src = ":source[" + p + "]",
        defines = ["__GMP_WITHIN_GMP"],
        flags = FLAGS,
        headers = INCLUDES,
        includes = INCLUDES,
        object_name = "a" + str(i) + ".o",
        toolchain = CC,
    )
    for i, p in enumerate(C_SOURCES)
]

[
    c_object(
        name = "mpn-" + name + ".o",
        src = ":source[" + p + "]",
        defines = [
            "__GMP_WITHIN_GMP",
            "OPERATION_" + name,
        ],
        flags = FLAGS,
        headers = INCLUDES,
        includes = INCLUDES,
        object_name = "n" + str(i) + ".o",
        toolchain = CC,
    )
    for i, (name, p) in enumerate(MPN_SOURCES.items())
]

[
    c_object(
        name = name + ".o",
        src = ":" + name + ".c",
        defines = ["__GMP_WITHIN_GMP"],
        flags = FLAGS,
        headers = INCLUDES,
        includes = INCLUDES,
        object_name = name + ".o",
        toolchain = CC,
    )
    for name in [
        "fib_table",
        "mp_bases",
    ]
]

c_library(
    name = "libgmp.a",
    objects = [":api-" + str(i) + ".o" for i in range(len(C_SOURCES))] +
              [":mpn-" + name + ".o" for name in MPN_SOURCES] + [
        ":fib_table.o",
        ":mp_bases.o",
    ],
    output = "libgmp.a",
    toolchain = CC,
)

[
    c_object(
        name = "support-" + str(i) + ".o",
        src = ":source[" + p + "]",
        flags = FLAGS,
        headers = INCLUDES,
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
            src = ":source[" + p + "]",
            flags = FLAGS,
            headers = INCLUDES,
            includes = INCLUDES + [":source[tests]"],
            toolchain = CC,
        ),
        c_binary(
            name = "test-" + name + "-program",
            end_objects = CRTN,
            libraries = [
                ":libtests.a",
                ":libgmp.a",
            ] + LIBC,
            objects = CRT + [":test-" + name + ".o"],
            toolchain = CC,
        ),
        generate(
            name = name + "-scratch",
            args = [
                "stdout",
                "$(exe :test-" + name + "-program)",
            ],
            chdir = "cellar//bootstrap/stage0-posix/cellar-extra:chdirenv",
            directory = True,
            env = {"GMP_CHECK_RANDOMIZE": "42"},
            files = ["stdout"],
            tool = "cellar//bootstrap/stage1/tools:capture",
        ) if name in [
            "misc-t-printf",
            "misc-t-scanf",
        ] else None,
        command_test(
            name = name,
            args = [
                "$(location :" + name + "-scratch[stdout])",
                "$(location :expected-seed-output)",
            ],
            tool = "cellar//bootstrap/stage0-posix/cellar-extra:bytecmp",
        ) if name in [
            "misc-t-printf",
            "misc-t-scanf",
        ] else command_test(
            name = name,
            env = {"GMP_CHECK_RANDOMIZE": "42"},
            tool = ":test-" + name + "-program",
        ),
    ]
    for name, p in TESTS.items()
]

write_file(
    name = "expected-seed-output",
    content = "Re-seeding with GMP_CHECK_RANDOMIZE=42\n",
)

filegroup(
    name = "headers",
    srcs = {"gmp.h": ":gmp.h"},
)

filegroup(
    name = "installation",
    srcs = {
        "include/gmp.h": ":gmp.h",
        "lib/libgmp.a": ":libgmp.a",
        "share/licenses/gmp/COPYING": ":gmp-6.2.1[COPYING]",
        "share/licenses/gmp/COPYING.LESSERv3": ":gmp-6.2.1[COPYING.LESSERv3]",
        "share/licenses/gmp/COPYINGv2": ":gmp-6.2.1[COPYINGv2]",
        "share/licenses/gmp/COPYINGv3": ":gmp-6.2.1[COPYINGv3]",
    },
)

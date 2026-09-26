# SPDX-FileCopyrightText: 2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

load("@cellar//bootstrap:actions.bzl", "command_test", "compare_test", "concatenate", "configured_tool", "generate", "result_test")
load("@cellar//bootstrap:defs.bzl", "export_file", "filegroup")
load("@cellar//bootstrap:source.bzl", "exact_patch", "project_files", "write_file")
load("@cellar//bootstrap/stage1:defs.bzl", "c_library", "c_object")
load(":sources.bzl", "HEADER_FILES", "LIBRARY_OBJECTS", "SOURCES", "SUPCXX_OBJECTS")

GCC = "cellar//bootstrap/stage1/gcc47"

MUSL = "cellar//bootstrap/stage1/musl12"

STAGES = [
    "stage1",
    "stage2",
    "stage3",
]

SED = "cellar//bootstrap/stage1/sed:sed"

# The compiler package extracts the same release; build from its tree.
project_files(
    name = "gcc-4.7.4",
    files = SOURCES + ["gcc/DATESTAMP"],
    tree = GCC + ":gcc-4.7.4",
)

export_file(name = "patches/gthr.patch")

exact_patch(
    name = "os_defines.h",
    src = ":gcc-4.7.4[libstdc++-v3/config/os/generic/os_defines.h]",
    patch = ":patches/gthr.patch",
)

# Reviewed x86_64 musl configuration; no target configure process runs.
# Musl uses 64-bit off_t directly; the optional *64 libc aliases are absent.
CONFIG_ON = [
    "HAVE_ACOSF",
    "HAVE_ACOSL",
    "HAVE_ASINF",
    "HAVE_ASINL",
    "HAVE_AS_SYMVER_DIRECTIVE",
    "HAVE_ATAN2F",
    "HAVE_ATAN2L",
    "HAVE_ATANF",
    "HAVE_ATANL",
    "HAVE_CC_TLS",
    "HAVE_CEILF",
    "HAVE_CEILL",
    "HAVE_COMPLEX_H",
    "HAVE_COSF",
    "HAVE_COSHF",
    "HAVE_COSHL",
    "HAVE_COSL",
    "HAVE_DLFCN_H",
    "HAVE_EBADMSG",
    "HAVE_ECANCELED",
    "HAVE_ECHILD",
    "HAVE_EIDRM",
    "HAVE_ENDIAN_H",
    "HAVE_ENODATA",
    "HAVE_ENOLINK",
    "HAVE_ENOSPC",
    "HAVE_ENOSR",
    "HAVE_ENOSTR",
    "HAVE_ENOTRECOVERABLE",
    "HAVE_ENOTSUP",
    "HAVE_EOVERFLOW",
    "HAVE_EOWNERDEAD",
    "HAVE_EPERM",
    "HAVE_EPROTO",
    "HAVE_ETIME",
    "HAVE_ETIMEDOUT",
    "HAVE_ETXTBSY",
    "HAVE_EWOULDBLOCK",
    "HAVE_EXPF",
    "HAVE_EXPL",
    "HAVE_FABSF",
    "HAVE_FABSL",
    "HAVE_FENV_H",
    "HAVE_FINITE",
    "HAVE_FINITEF",
    "HAVE_FLOAT_H",
    "HAVE_FLOORF",
    "HAVE_FLOORL",
    "HAVE_FMODF",
    "HAVE_FMODL",
    "HAVE_FREXPF",
    "HAVE_FREXPL",
    "HAVE_GETS",
    "HAVE_HYPOT",
    "HAVE_HYPOTF",
    "HAVE_HYPOTL",
    "HAVE_ICONV",
    "HAVE_INT64_T",
    "HAVE_INT64_T_LONG",
    "HAVE_INTTYPES_H",
    "HAVE_ISINF",
    "HAVE_ISNAN",
    "HAVE_ISWBLANK",
    "HAVE_LC_MESSAGES",
    "HAVE_LDEXPF",
    "HAVE_LDEXPL",
    "HAVE_LIMIT_AS",
    "HAVE_LIMIT_DATA",
    "HAVE_LIMIT_FSIZE",
    "HAVE_LIMIT_RSS",
    "HAVE_LOCALE_H",
    "HAVE_LOG10F",
    "HAVE_LOG10L",
    "HAVE_LOGF",
    "HAVE_LOGL",
    "HAVE_MBSTATE_T",
    "HAVE_MEMORY_H",
    "HAVE_MODF",
    "HAVE_MODFF",
    "HAVE_MODFL",
    "HAVE_POLL",
    "HAVE_POWF",
    "HAVE_POWL",
    "HAVE_SETENV",
    "HAVE_SINCOS",
    "HAVE_SINCOSF",
    "HAVE_SINCOSL",
    "HAVE_SINF",
    "HAVE_SINHF",
    "HAVE_SINHL",
    "HAVE_SINL",
    "HAVE_SQRTF",
    "HAVE_SQRTL",
    "HAVE_STDALIGN_H",
    "HAVE_STDBOOL_H",
    "HAVE_STDINT_H",
    "HAVE_STDLIB_H",
    "HAVE_STRERROR_L",
    "HAVE_STRERROR_R",
    "HAVE_STRINGS_H",
    "HAVE_STRING_H",
    "HAVE_STRTOF",
    "HAVE_STRTOLD",
    "HAVE_STRXFRM_L",
    "HAVE_SYS_IOCTL_H",
    "HAVE_SYS_IPC_H",
    "HAVE_SYS_PARAM_H",
    "HAVE_SYS_RESOURCE_H",
    "HAVE_SYS_SEM_H",
    "HAVE_SYS_STAT_H",
    "HAVE_SYS_SYSINFO_H",
    "HAVE_SYS_TIME_H",
    "HAVE_SYS_TYPES_H",
    "HAVE_SYS_UIO_H",
    "HAVE_S_IFREG",
    "HAVE_S_ISREG",
    "HAVE_TANF",
    "HAVE_TANHF",
    "HAVE_TANHL",
    "HAVE_TANL",
    "HAVE_TGMATH_H",
    "HAVE_TLS",
    "HAVE_UNISTD_H",
    "HAVE_VFWSCANF",
    "HAVE_VSWSCANF",
    "HAVE_VWSCANF",
    "HAVE_WCHAR_H",
    "HAVE_WCSTOF",
    "HAVE_WCTYPE_H",
    "HAVE_WRITEV",
    "_GLIBCXX_ATOMIC_BUILTINS",
    "_GLIBCXX_HAS_GTHREADS",
    "_GLIBCXX_HOSTED",
    "_GLIBCXX_RES_LIMITS",
    "_GLIBCXX_USE_C99",
    "_GLIBCXX_USE_C99_COMPLEX",
    "_GLIBCXX_USE_C99_COMPLEX_TR1",
    "_GLIBCXX_USE_C99_CTYPE_TR1",
    "_GLIBCXX_USE_C99_FENV_TR1",
    "_GLIBCXX_USE_C99_INTTYPES_TR1",
    "_GLIBCXX_USE_C99_INTTYPES_WCHAR_T_TR1",
    "_GLIBCXX_USE_C99_MATH",
    "_GLIBCXX_USE_C99_MATH_TR1",
    "_GLIBCXX_USE_C99_STDINT_TR1",
    "_GLIBCXX_USE_CLOCK_MONOTONIC",
    "_GLIBCXX_USE_CLOCK_REALTIME",
    "_GLIBCXX_USE_DECIMAL_FLOAT",
    "_GLIBCXX_USE_FLOAT128",
    "_GLIBCXX_USE_GETTIMEOFDAY",
    "_GLIBCXX_USE_INT128",
    "_GLIBCXX_USE_LONG_LONG",
    "_GLIBCXX_USE_NANOSLEEP",
    "_GLIBCXX_USE_RANDOM_TR1",
    "_GLIBCXX_USE_SCHED_YIELD",
    "_GLIBCXX_USE_SC_NPROCESSORS_ONLN",
    "_GLIBCXX_USE_WCHAR_T",
    "_GTHREAD_USE_MUTEX_TIMEDLOCK",
    "STDC_HEADERS",
]

CONFIG_VALUES = {
    "SIZEOF_CHAR": "1",
    "SIZEOF_SHORT": "2",
    "SIZEOF_INT": "4",
    "SIZEOF_LONG": "8",
    "SIZEOF_VOID_P": "8",
    "ICONV_CONST": "",
    "_GLIBCXX_FULLY_DYNAMIC_STRING": "0",
    "_GLIBCXX_STDIO_EOF": "-1",
    "_GLIBCXX_STDIO_SEEK_CUR": "1",
    "_GLIBCXX_STDIO_SEEK_END": "2",
}

write_file(
    name = "config.h",
    content = "\n".join(["#define " + name + " 1" for name in CONFIG_ON]) + "\n" + "\n".join(["#define " + name + " " + value for name, value in CONFIG_VALUES.items()]) + "\n",
)

# stamp-cxx-config dates the library with gcc/DATESTAMP.
generate(
    name = "glibcxx-date.sed",
    args = [
        "-e",
        "s|^[0-9][0-9]*$|s/define __GLIBCXX__$/define __GLIBCXX__ &/|",
        "$(location :gcc-4.7.4[gcc/DATESTAMP])",
    ],
    capture = True,
    tool = SED,
)

generate(
    name = "cxxconfig-base",
    args = [
        "-f",
        "$(location :glibcxx-date.sed)",
        "-e",
        "s/define _GLIBCXX_INLINE_VERSION *$/define _GLIBCXX_INLINE_VERSION 0/",
        "-e",
        "s/define _GLIBCXX_HAVE_ATTRIBUTE_VISIBILITY$/define _GLIBCXX_HAVE_ATTRIBUTE_VISIBILITY 1/",
        "-e",
        "s/define _GLIBCXX_EXTERN_TEMPLATE$/define _GLIBCXX_EXTERN_TEMPLATE 1/",
        "$(location :gcc-4.7.4[libstdc++-v3/include/bits/c++config])",
    ],
    capture = True,
    tool = SED,
)

generate(
    name = "cxxconfig-settings",
    args = [
        "-e",
        "s/HAVE_/_GLIBCXX_HAVE_/g",
        "-e",
        "s/PACKAGE/_GLIBCXX_PACKAGE/g",
        "-e",
        "s/VERSION/_GLIBCXX_VERSION/g",
        "-e",
        "s/WORDS_/_GLIBCXX_WORDS_/g",
        "-e",
        "s/ICONV_CONST/_GLIBCXX_ICONV_CONST/g",
        "$(location :config.h)",
    ],
    capture = True,
    tool = SED,
)

write_file(
    name = "cxxconfig-end",
    content = "\n#endif // _GLIBCXX_CXX_CONFIG_H\n",
)

concatenate(
    name = "c++config.h",
    inputs = [
        ":cxxconfig-base",
        ":cxxconfig-settings",
        ":cxxconfig-end",
    ],
    output = "c++config.h",
    tool = "cellar//bootstrap/stage0-posix/mescc-tools-extra:catm",
)

GTHREAD_TRANSFORMS = {
    "gthr.h": [
        "/^#pragma/b",
        "/^#/s/\\([ABCDEFGHIJKLMNOPQRSTUVWXYZ_][ABCDEFGHIJKLMNOPQRSTUVWXYZ_]*\\)/_GLIBCXX_\\1/g",
        "s/_GLIBCXX_SUPPORTS_WEAK/__GXX_WEAK__/g",
        's,^#include "\\(.*\\)",#include <bits/\\1>,g',
    ],
    "gthr-single.h": [
        "s/\\(UNUSED\\)/_GLIBCXX_\\1/g",
        "s/\\(GCC[ABCDEFGHIJKLMNOPQRSTUVWXYZ_]*_H\\)/_GLIBCXX_\\1/g",
    ],
    "gthr-posix.h": [
        "s/\\(UNUSED\\)/_GLIBCXX_\\1/g",
        "s/\\(GCC[ABCDEFGHIJKLMNOPQRSTUVWXYZ_]*_H\\)/_GLIBCXX_\\1/g",
        "s/SUPPORTS_WEAK/__GXX_WEAK__/g",
        "s/\\([ABCDEFGHIJKLMNOPQRSTUVWXYZ_]*USE_WEAK\\)/_GLIBCXX_\\1/g",
    ],
}

[
    generate(
        name = name,
        args = [arg for transform in transforms for arg in [
            "-e",
            transform,
        ]] + ["$(location :gcc-4.7.4[libgcc/" + name + "])"],
        capture = True,
        output = name,
        tool = SED,
    )
    for name, transforms in GTHREAD_TRANSFORMS.items()
]

filegroup(
    name = "headers",
    srcs = {name: ":gcc-4.7.4[" + source + "]" for name, source in HEADER_FILES.items() if name != "bits/os_defines.h"} | {
        "bits/os_defines.h": ":os_defines.h",
        "bits/c++config.h": ":c++config.h",
        "bits/gthr.h": ":gthr.h",
        "bits/gthr-single.h": ":gthr-single.h",
        "bits/gthr-posix.h": ":gthr-posix.h",
        "bits/gthr-default.h": ":gthr-posix.h",
    },
)

write_file(
    name = "gstdint.h",
    content = "#include <stdint.h>\n",
)

# Each target library is built by the new compiler, not its predecessor.
[filegroup(
    name = stage + "-source",
    srcs = {path: ":gcc-4.7.4[" + path + "]" for path in SOURCES} | {
        "headers": ":headers",
        "config.h": ":config.h",
        "gstdint.h": ":gstdint.h",
        "gcc-include": GCC + ":" + stage + "-library-source[include]",
    },
) for stage in STAGES]

LIBRARY_INCLUDES = [
    "headers",
    "headers/backward",
    "libstdc++-v3/libsupc++",
    "libstdc++-v3/src/c++98",
    "libstdc++-v3/src/c++11",
    "gcc-include",
    "libgcc",
    ".",
]

CXX11_SUPCXX = [
    "eh_ptr.cc",
    "eh_throw.cc",
    "guard.cc",
    "nested_exception.cc",
]

LIBRARY_FLAGS = [
    "-O2",
    "-g0",
    "-fPIC",
    "-Werror",
]

[c_object(
    name = stage + "-" + name + ".o",
    src = ":" + stage + "-source[" + source + "]",
    defines = ["_GNU_SOURCE=1"] + (["_GLIBCXX_CONCEPT_CHECKS=1"] if name == "98-concept-inst.cc" else []),
    flags = LIBRARY_FLAGS + [
                "-x",
                "c++",
                "-std=gnu++11" if name.startswith("11-") or name in CXX11_SUPCXX else "-std=gnu++98",
            ] + (["-fno-implicit-templates"] if name not in SUPCXX_OBJECTS else []) +
            (["-fimplicit-templates"] if name == "98-concept-inst.cc" else []) +
            (["-Wno-deprecated"] if name == "98-strstream.cc" else []),
    logical_includes = LIBRARY_INCLUDES,
    logical_source = source,
    object_name = "cx" + str(i) + ".o",
    source_tree = ":" + stage + "-source",
    toolchain = GCC + ":" + stage + "-gcc",
) for stage in STAGES for i, (name, source) in enumerate(LIBRARY_OBJECTS.items())]

[c_object(
    name = stage + "-cp-demangle.o",
    src = ":" + stage + "-source[libiberty/cp-demangle.c]",
    defines = [
        "HAVE_CONFIG_H=1",
        "IN_GLIBCPP_V3=1",
        "_GNU_SOURCE=1",
    ],
    flags = LIBRARY_FLAGS,
    logical_includes = LIBRARY_INCLUDES,
    logical_source = "libiberty/cp-demangle.c",
    object_name = "demangle.o",
    source_tree = ":" + stage + "-source",
    toolchain = GCC + ":" + stage + "-gcc",
) for stage in STAGES]

[c_library(
    name = stage + "-lib" + library + ".a",
    objects = [":" + stage + "-" + name + ".o" for name in names] + [":" + stage + "-cp-demangle.o"],
    output = "lib" + library + ".a",
    toolchain = GCC + ":" + stage + "-gcc",
) for stage in STAGES for library, names in {
    "stdc++": LIBRARY_OBJECTS.keys(),
    "supc++": SUPCXX_OBJECTS,
}.items()]

[filegroup(
    name = stage + "-libraries",
    srcs = {
        "libstdc++.a": ":" + stage + "-libstdc++.a",
        "libsupc++.a": ":" + stage + "-libsupc++.a",
    },
) for stage in STAGES]

[configured_tool(
    name = stage + "-g++",
    args = [
        "-B$(location " + GCC + ":" + stage + "-native-tools)/",
        "-B$(location " + GCC + ":" + stage + "-runtime)/lib/",
        "-L$(location :" + stage + "-libraries)",
        "-nostdinc",
        "-nostdinc++",
        "-isystem",
        "$(location :headers)",
        "-isystem",
        "$(location " + GCC + ":compiler-headers)",
        "-isystem",
        "$(location " + GCC + ":" + stage + "-runtime[include])",
    ],
    env = {"TMPDIR": "."},
    tool = GCC + ":" + stage + "-g++",
) for stage in STAGES]

TESTS = {
    "exceptions": "gnu++11",
    "supcxx": "gnu++98",
    "containers": "gnu++98",
    "cxx11": "gnu++11",
    "threads": "gnu++11",
    "streams": "gnu++98",
}

filegroup(
    name = "tests",
    srcs = {"tests/" + name: "tests/" + name for name in [
        "exception.h",
        "supcxx.cc",
        "throw.cc",
        "exceptions.cc",
        "containers.cc",
        "cxx11.cc",
        "threads.cc",
        "streams.cc",
    ]},
)

[generate(
    name = stage + "-" + name + "-" + optimization + "-program",
    args = [
        "-" + optimization,
        "-g0",
        "-frandom-seed=bootstrap",
        "-Werror",
        "-std=" + standard,
        "source/tests/" + name + ".cc",
    ] + (["-pthread"] if name == "threads" else []) + (["source/tests/throw.cc"] if name in [
        "exceptions",
        "supcxx",
    ] else []) + ([
        "-nodefaultlibs",
        "-Wl,--start-group",
        "-lsupc++",
        "-lgcc",
        "-lc",
        "-Wl,--end-group",
    ] if name == "supcxx" else []) + [
        "-o",
        "program",
    ],
    chdir = True,
    directory = True,
    files = ["program"],
    source_tree = ":tests",
    tool = ":" + stage + "-g++",
) for stage in STAGES for name, standard in TESTS.items() for optimization in [
    "O0",
    "O2",
]]

[command_test(
    name = stage + "-" + name + "-" + optimization,
    args = [
        "0",
        "$(location :" + stage + "-" + name + "-" + optimization + "-program[program])",
    ],
    tool = "cellar//bootstrap/stage1/tools:expect-exit",
) for stage in STAGES for name in TESTS if name != "streams" for optimization in [
    "O0",
    "O2",
]]

[[
    generate(
        name = stage + "-streams-" + optimization + "-work",
        args = [
            "0",
            "$(location :" + stage + "-streams-" + optimization + "-program[program])",
        ],
        chdir = True,
        directory = True,
        files = ["passed"],
        tool = "cellar//bootstrap/stage1/tools:expect-exit",
    ),
    result_test(
        name = stage + "-streams-" + optimization,
        result = ":" + stage + "-streams-" + optimization + "-work[passed]",
    ),
] for stage in STAGES for optimization in [
    "O0",
    "O2",
]]

COMPARED = [name + ".o" for name in LIBRARY_OBJECTS] + [
    "cp-demangle.o",
    "libstdc++.a",
    "libsupc++.a",
]

[compare_test(
    name = "compare-" + name,
    actual = ":stage2-" + name,
    expected = ":stage3-" + name,
) for name in COMPARED]

filegroup(
    name = "stage-comparison",
    srcs = {},
    tests = [":compare-" + name for name in COMPARED],
)

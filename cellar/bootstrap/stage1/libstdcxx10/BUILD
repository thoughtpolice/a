# SPDX-FileCopyrightText: 2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

load("@cellar//bootstrap:actions.bzl", "command_test", "concatenate", "configured_tool", "generate")
load("@cellar//bootstrap:defs.bzl", "export_file", "filegroup")
load("@cellar//bootstrap:source.bzl", "untar", "write_file")
load("@cellar//bootstrap/stage1:defs.bzl", "bootstrap_artifact", "c_library", "c_object")
load(":sources.bzl", "HEADER_FILES", "LIBRARY_OBJECTS")

GCC = "cellar//bootstrap/stage1/gcc10"

STAGES = [
    "stage1",
    "stage2",
    "stage3",
]

SOURCE_ALIAS = "cellar//bootstrap/stage1/tools:source-alias"

CAPTURE = "cellar//bootstrap/stage1/tools:capture"

SED = "cellar//bootstrap/stage1/sed:sed"

CATM = "cellar//bootstrap/stage0-posix/mescc-tools-extra:catm"

CHDIRENV = "cellar//bootstrap/stage0-posix/cellar-extra:chdirenv"

SOURCE_DIRECTORIES = [
    "include",
    "libstdc++-v3/config",
    "libstdc++-v3/libsupc++",
    "libstdc++-v3/src",
]

SOURCE_FILES = [
    "COPYING.RUNTIME",
    "COPYING3",
    "libgcc/gthr.h",
    "libgcc/gthr-posix.h",
    "libgcc/gthr-single.h",
    "libgcc/unwind-pe.h",
    "libiberty/cp-demangle.c",
    "libiberty/cp-demangle.h",
    "libstdc++-v3/include/bits/c++config",
]

untar(
    name = "gcc-10.5.0",
    chdirenv = CHDIRENV,
    files = SOURCE_DIRECTORIES + SOURCE_FILES + ["gcc/DATESTAMP"] + {source: None for source in HEADER_FILES.values()}.keys(),
    flags = ["-xf"],
    input = GCC + ":gcc.tar",
    untar = "cellar//bootstrap/stage1/pax:untar",
)

# Reviewed x86_64 musl 1.2.5 configuration; no target configure process runs.
# Symbol versioning, *64 large-file aliases and glibc locale internals are
# absent, as in an upstream static build against musl.
CONFIG_ON = [
    "HAVE_ACOSF",
    "HAVE_ACOSL",
    "HAVE_ASINF",
    "HAVE_ASINL",
    "HAVE_ATAN2F",
    "HAVE_ATAN2L",
    "HAVE_ATANF",
    "HAVE_ATANL",
    "HAVE_CEILF",
    "HAVE_CEILL",
    "HAVE_COSF",
    "HAVE_COSHF",
    "HAVE_COSHL",
    "HAVE_COSL",
    "HAVE_EXPF",
    "HAVE_EXPL",
    "HAVE_FABSF",
    "HAVE_FABSL",
    "HAVE_FINITE",
    "HAVE_FINITEF",
    "HAVE_FLOORF",
    "HAVE_FLOORL",
    "HAVE_FMODF",
    "HAVE_FMODL",
    "HAVE_FREXPF",
    "HAVE_FREXPL",
    "HAVE_HYPOT",
    "HAVE_HYPOTF",
    "HAVE_HYPOTL",
    "HAVE_ISINF",
    "HAVE_ISNAN",
    "HAVE_LDEXPF",
    "HAVE_LDEXPL",
    "HAVE_LOG10F",
    "HAVE_LOG10L",
    "HAVE_LOGF",
    "HAVE_LOGL",
    "HAVE_MODF",
    "HAVE_MODFF",
    "HAVE_MODFL",
    "HAVE_POWF",
    "HAVE_POWL",
    "HAVE_SINCOS",
    "HAVE_SINCOSF",
    "HAVE_SINCOSL",
    "HAVE_SINF",
    "HAVE_SINHF",
    "HAVE_SINHL",
    "HAVE_SINL",
    "HAVE_SQRTF",
    "HAVE_SQRTL",
    "HAVE_TANF",
    "HAVE_TANHF",
    "HAVE_TANHL",
    "HAVE_TANL",
    "HAVE_AT_QUICK_EXIT",
    "HAVE_QUICK_EXIT",
    "HAVE_SETENV",
    "HAVE_STRTOF",
    "HAVE_STRTOLD",
    "HAVE_ALIGNED_ALLOC",
    "HAVE_MEMALIGN",
    "HAVE_POSIX_MEMALIGN",
    "HAVE_TIMESPEC_GET",
    "HAVE_SOCKATMARK",
    "HAVE_ARPA_INET_H",
    "HAVE_COMPLEX_H",
    "HAVE_DIRENT_H",
    "HAVE_DLFCN_H",
    "HAVE_ENDIAN_H",
    "HAVE_FCNTL_H",
    "HAVE_FENV_H",
    "HAVE_FLOAT_H",
    "HAVE_INTTYPES_H",
    "HAVE_LOCALE_H",
    "HAVE_MEMORY_H",
    "HAVE_NETDB_H",
    "HAVE_NETINET_IN_H",
    "HAVE_NETINET_TCP_H",
    "HAVE_POLL_H",
    "HAVE_STDALIGN_H",
    "HAVE_STDBOOL_H",
    "HAVE_STDINT_H",
    "HAVE_STDLIB_H",
    "HAVE_STRINGS_H",
    "HAVE_STRING_H",
    "HAVE_SYS_IOCTL_H",
    "HAVE_SYS_IPC_H",
    "HAVE_SYS_PARAM_H",
    "HAVE_SYS_RESOURCE_H",
    "HAVE_SYS_SEM_H",
    "HAVE_SYS_SOCKET_H",
    "HAVE_SYS_STATVFS_H",
    "HAVE_SYS_STAT_H",
    "HAVE_SYS_SYSINFO_H",
    "HAVE_SYS_TIME_H",
    "HAVE_SYS_TYPES_H",
    "HAVE_SYS_UIO_H",
    "HAVE_TGMATH_H",
    "HAVE_UCHAR_H",
    "HAVE_UNISTD_H",
    "HAVE_UTIME_H",
    "HAVE_WCHAR_H",
    "HAVE_WCTYPE_H",
    "STDC_HEADERS",
    "HAVE_AS_SYMVER_DIRECTIVE",
    "HAVE_ATOMIC_LOCK_POLICY",
    "HAVE_CC_TLS",
    "HAVE_TLS",
    "HAVE_GETIPINFO",
    "HAVE_GETS",
    "HAVE_ICONV",
    "HAVE_INT64_T",
    "HAVE_INT64_T_LONG",
    "HAVE_ISWBLANK",
    "HAVE_VFWSCANF",
    "HAVE_VSWSCANF",
    "HAVE_VWSCANF",
    "HAVE_WCSTOF",
    "HAVE_LC_MESSAGES",
    "HAVE_LIMIT_AS",
    "HAVE_LIMIT_DATA",
    "HAVE_LIMIT_FSIZE",
    "HAVE_LIMIT_RSS",
    "HAVE_LINUX_FUTEX",
    "HAVE_MBSTATE_T",
    "HAVE_POLL",
    "HAVE_STRERROR_R",
    "HAVE_S_ISREG",
    "HAVE_WRITEV",
    "HAVE_STRUCT_DIRENT_D_TYPE",
    "HAVE_LINK",
    "HAVE_READLINK",
    "HAVE_SYMLINK",
    "HAVE_TRUNCATE",
    "_GLIBCXX_USE_FCHMOD",
    "_GLIBCXX_USE_FCHMODAT",
    "_GLIBCXX_USE_LSTAT",
    "_GLIBCXX_USE_REALPATH",
    "_GLIBCXX_USE_SENDFILE",
    "_GLIBCXX_USE_ST_MTIM",
    "_GLIBCXX_USE_UTIME",
    "_GLIBCXX_USE_UTIMENSAT",
    "_GLIBCXX_ATOMIC_BUILTINS",
    "_GLIBCXX_HAS_GTHREADS",
    "_GLIBCXX_USE_PTHREAD_RWLOCK_T",
    "_GLIBCXX_RES_LIMITS",
    "_GLIBCXX_USE_C99",
    "_GLIBCXX98_USE_C99_COMPLEX",
    "_GLIBCXX98_USE_C99_MATH",
    "_GLIBCXX98_USE_C99_STDIO",
    "_GLIBCXX98_USE_C99_STDLIB",
    "_GLIBCXX98_USE_C99_WCHAR",
    "_GLIBCXX11_USE_C99_COMPLEX",
    "_GLIBCXX11_USE_C99_MATH",
    "_GLIBCXX11_USE_C99_STDIO",
    "_GLIBCXX11_USE_C99_STDLIB",
    "_GLIBCXX11_USE_C99_WCHAR",
    "_GLIBCXX_USE_C99_COMPLEX_TR1",
    "_GLIBCXX_USE_C99_CTYPE_TR1",
    "_GLIBCXX_USE_C99_FENV_TR1",
    "_GLIBCXX_USE_C99_INTTYPES_TR1",
    "_GLIBCXX_USE_C99_INTTYPES_WCHAR_T_TR1",
    "_GLIBCXX_USE_C99_MATH_TR1",
    "_GLIBCXX_USE_C99_STDINT_TR1",
    "_GLIBCXX_USE_C11_UCHAR_CXX11",
    "_GLIBCXX_USE_CLOCK_MONOTONIC",
    "_GLIBCXX_USE_CLOCK_REALTIME",
    "_GLIBCXX_USE_NANOSLEEP",
    "_GLIBCXX_USE_SCHED_YIELD",
    "_GLIBCXX_USE_GETTIMEOFDAY",
    "_GLIBCXX_USE_DECIMAL_FLOAT",
    "_GLIBCXX_USE_DEV_RANDOM",
    "_GLIBCXX_USE_RANDOM_TR1",
    "_GLIBCXX_USE_GET_NPROCS",
    "_GLIBCXX_USE_SC_NPROCESSORS_ONLN",
    "_GLIBCXX_USE_INT128",
    "_GLIBCXX_USE_LONG_LONG",
    "_GLIBCXX_USE_TMPNAM",
    "_GLIBCXX_USE_WCHAR_T",
    "_GLIBCXX_X86_RDRAND",
    "_GLIBCXX_X86_RDSEED",
]

CONFIG_VALUES = {
    "HAVE_LIMIT_VMEM": "0",
    "ICONV_CONST": "",
    "SIZEOF_CHAR": "1",
    "SIZEOF_SHORT": "2",
    "SIZEOF_INT": "4",
    "SIZEOF_LONG": "8",
    "SIZEOF_VOID_P": "8",
    "_GLIBCXX_FULLY_DYNAMIC_STRING": "0",
    "_GLIBCXX_HOSTED": "1",
    "_GLIBCXX_MANGLE_SIZE_T": "m",
    "_GLIBCXX_STDIO_EOF": "-1",
    "_GLIBCXX_STDIO_SEEK_CUR": "1",
    "_GLIBCXX_STDIO_SEEK_END": "2",
    "_GLIBCXX_VERBOSE": "1",
    "_GTHREAD_USE_MUTEX_TIMEDLOCK": "1",
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
        "s/^[0-9][0-9]*$/s,define __GLIBCXX__,define __GLIBCXX__ &,/",
        "$(location :gcc-10.5.0[gcc/DATESTAMP])",
    ],
    capture = CAPTURE,
    tool = SED,
)

# libstdc++-v3/include/Makefile.am's stamp-cxx-config pipeline.
generate(
    name = "cxxconfig-base",
    args = [
        "-f",
        "$(location :glibcxx-date.sed)",
        "-e",
        "s,define _GLIBCXX_RELEASE,define _GLIBCXX_RELEASE 10,",
        "-e",
        "s,define _GLIBCXX_INLINE_VERSION, define _GLIBCXX_INLINE_VERSION 0,",
        "-e",
        "s,define _GLIBCXX_HAVE_ATTRIBUTE_VISIBILITY, define _GLIBCXX_HAVE_ATTRIBUTE_VISIBILITY 1,",
        "-e",
        "s,define _GLIBCXX_EXTERN_TEMPLATE$, define _GLIBCXX_EXTERN_TEMPLATE 1,",
        "-e",
        "s,define _GLIBCXX_USE_DUAL_ABI, define _GLIBCXX_USE_DUAL_ABI 1,",
        "-e",
        "s,define _GLIBCXX_USE_CXX11_ABI, define _GLIBCXX_USE_CXX11_ABI 1,",
        "-e",
        "s,define _GLIBCXX_USE_ALLOCATOR_NEW, define _GLIBCXX_USE_ALLOCATOR_NEW 1,",
        "-e",
        "s,define _GLIBCXX_USE_FLOAT128,define _GLIBCXX_USE_FLOAT128 1,",
        "$(location :gcc-10.5.0[libstdc++-v3/include/bits/c++config])",
    ],
    capture = CAPTURE,
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
        "s/LT_OBJDIR/_GLIBCXX_LT_OBJDIR/g",
        "-e",
        "s/STDC_HEADERS/_GLIBCXX_STDC_HEADERS/g",
        "-e",
        "s/_DARWIN_USE_64_BIT_INODE/_GLIBCXX_DARWIN_USE_64_BIT_INODE/g",
        "-e",
        "s/_FILE_OFFSET_BITS/_GLIBCXX_FILE_OFFSET_BITS/g",
        "-e",
        "s/_LARGE_FILES/_GLIBCXX_LARGE_FILES/g",
        "-e",
        "s/ICONV_CONST/_GLIBCXX_ICONV_CONST/g",
        "-e",
        "/[\t ]_GLIBCXX_LONG_DOUBLE_COMPAT[\t ]/d",
        "$(location :config.h)",
    ],
    capture = CAPTURE,
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
    tool = CATM,
)

GTHREAD_TRANSFORMS = {
    "gthr.h": [
        "/^#pragma/b",
        "/^#/s/\\([ABCDEFGHIJKLMNOPQRSTUVWXYZ_][ABCDEFGHIJKLMNOPQRSTUVWXYZ_]*\\)/_GLIBCXX_\\1/g",
        "s/_GLIBCXX_SUPPORTS_WEAK/__GXX_WEAK__/g",
        "s/_GLIBCXX___MINGW32_GLIBCXX___/__MINGW32__/g",
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
        ]] + ["$(location :gcc-10.5.0[libgcc/" + name + "])"],
        capture = CAPTURE,
        output = name,
        tool = SED,
    )
    for name, transforms in GTHREAD_TRANSFORMS.items()
]

# libgcc/gthr-posix.h has no quoted includes, so the default thread header is
# the transformed POSIX header.
filegroup(
    name = "headers",
    srcs = {name: ":gcc-10.5.0[" + source + "]" for name, source in HEADER_FILES.items()} | {
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

# AC_SYS_LARGEFILE defines nothing on LP64, but the filesystem sources
# include the build-only header.
write_file(
    name = "largefile-config.h",
    content = "",
)

[
    filegroup(
        name = stage + "-source",
        srcs = {path: ":gcc-10.5.0[" + path + "]" for path in SOURCE_DIRECTORIES + SOURCE_FILES} | {
            "headers": ":headers",
            "build/bits/largefile-config.h": ":largefile-config.h",
            "config.h": ":config.h",
            "gstdint.h": ":gstdint.h",
        },
    )
    for stage in STAGES
]

LIBRARY_INCLUDES = [
    "headers",
    "build",
    "libstdc++-v3/libsupc++",
    "libgcc",
    "include",
    ".",
]

LIBRARY_FLAGS = [
    "-O2",
    "-ffunction-sections",
    "-fdata-sections",
]

# cxx11-ios_failure's type_info is repointed at the old-ABI failure vtable in
# assembly, as libstdc++-v3/src/c++11/Makefile.am does.
IOS_FAILURE = "cxx11-ios_failure"

[
    c_object(
        name = stage + "-" + group + "-" + name + ".o",
        src = ":" + stage + "-source",
        flags = LIBRARY_FLAGS + ([] if source.endswith(".c") else [
            "-x",
            "c++",
        ]) + flags + (["-Isource/headers/backward"] if name == "strstream" else []),
        logical_includes = LIBRARY_INCLUDES,
        logical_source = source,
        object_name = "cx" + str(i) + ".o",
        source_alias = SOURCE_ALIAS,
        source_tree = ":" + stage + "-source",
        toolchain = GCC + ":" + stage + "-gcc",
    )
    for stage in STAGES
    for i, (group, name, source, flags) in enumerate(LIBRARY_OBJECTS)
    if name != IOS_FAILURE
]

[
    [
        generate(
            name = stage + "-" + IOS_FAILURE + ".s",
            args = LIBRARY_FLAGS + [
                "-frandom-seed=bootstrap",
                "-g0",
                "-x",
                "c++",
            ] + flags + ["-Isource/" + path for path in LIBRARY_INCLUDES] + [
                "-S",
                "source/" + source,
                "-o",
                "unit.s",
            ],
            chdir = CHDIRENV,
            directory = True,
            files = ["unit.s"],
            source_alias = SOURCE_ALIAS,
            source_tree = ":" + stage + "-source",
            tool = GCC + ":" + stage + "-gcc-command",
        ),
        generate(
            name = stage + "-" + IOS_FAILURE + "-rewritten.s",
            args = [
                "-e",
                "/^_*_ZTISt13__ios_failure:/,/_ZTVN10__cxxabiv120__si_class_type_infoE/s/_ZTVN10__cxxabiv120__si_class_type_infoE/_ZTVSt19__iosfail_type_info/",
                "$(location :" + stage + "-" + IOS_FAILURE + ".s[unit.s])",
            ],
            capture = CAPTURE,
            output = "unit.s",
            tool = SED,
        ),
        generate(
            name = stage + "-" + IOS_FAILURE + "-assembled",
            args = [
                "--64",
                "$(location :" + stage + "-" + IOS_FAILURE + "-rewritten.s)",
                "-o",
            ],
            output = "unit.o",
            tool = "cellar//bootstrap/stage1/binutils:as",
        ),
        bootstrap_artifact(
            name = stage + "-c++11-" + IOS_FAILURE + ".o",
            src = ":" + stage + "-" + IOS_FAILURE + "-assembled",
            abi = "x86_64-sysv",
            kind = "object",
            object_format = "elf64-x86-64",
        ),
    ]
    for stage in STAGES
    for group, name, source, flags in LIBRARY_OBJECTS
    if name == IOS_FAILURE
]

ARCHIVES = {
    "stdc++": [
        "libsupc++",
        "c++98",
        "c++11",
        "c++17",
        "compat",
    ],
    "supc++": ["libsupc++"],
    "stdc++fs": ["filesystem"],
}

[c_library(
    name = stage + "-lib" + library + ".a",
    objects = [":" + stage + "-" + group + "-" + name + ".o" for group, name, source, flags in LIBRARY_OBJECTS if group in groups],
    output = "lib" + library + ".a",
    toolchain = GCC + ":" + stage + "-gcc",
) for stage in STAGES for library, groups in ARCHIVES.items()]

[filegroup(
    name = stage + "-libraries",
    srcs = {"lib" + library + ".a": ":" + stage + "-lib" + library + ".a" for library in ARCHIVES},
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
    env_tool = "cellar//bootstrap/stage1/tools:withenv",
    tool = GCC + ":" + stage + "-g++",
) for stage in STAGES]

[filegroup(
    name = stage + "-installation",
    srcs = {
        "include/c++/10.5.0": ":headers",
        "lib/libstdc++.a": ":" + stage + "-libstdc++.a",
        "lib/libsupc++.a": ":" + stage + "-libsupc++.a",
        "lib/libstdc++fs.a": ":" + stage + "-libstdc++fs.a",
        "share/licenses/libstdc++/COPYING3": ":gcc-10.5.0[COPYING3]",
        "share/licenses/libstdc++/COPYING.RUNTIME": ":gcc-10.5.0[COPYING.RUNTIME]",
    },
) for stage in STAGES]

TESTS = {
    "exceptions": "gnu++11",
    "supcxx": "gnu++98",
    "containers": "gnu++98",
    "cxx11": "gnu++11",
    "threads": "gnu++11",
    "streams": "gnu++98",
    "cxx17": "gnu++17",
}

# Programs that write files run in their own output directory.
WRITING_TESTS = [
    "streams",
    "cxx17",
]

# The libstdc++ 13 port runs these tests too.
[export_file(name = path) for path in glob(["tests/*"])]

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
        "cxx17.cc",
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
    ] + (["-pthread"] if name in [
        "threads",
        "cxx17",
    ] else []) + (["source/tests/throw.cc"] if name in [
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
    chdir = CHDIRENV,
    directory = True,
    files = ["program"],
    source_alias = SOURCE_ALIAS,
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
) for stage in STAGES for name in TESTS if name not in WRITING_TESTS for optimization in [
    "O0",
    "O2",
]]

write_file(
    name = "passed",
    content = "passed\n",
)

[[
    generate(
        name = stage + "-" + name + "-" + optimization + "-work",
        args = [
            "0",
            "$(location :" + stage + "-" + name + "-" + optimization + "-program[program])",
        ],
        chdir = CHDIRENV,
        directory = True,
        files = ["passed"],
        tool = "cellar//bootstrap/stage1/tools:expect-exit",
    ),
    command_test(
        name = stage + "-" + name + "-" + optimization,
        args = [
            "$(location :" + stage + "-" + name + "-" + optimization + "-work[passed])",
            "$(location :passed)",
        ],
        tool = "cellar//bootstrap/stage0-posix/cellar-extra:bytecmp",
    ),
] for stage in STAGES for name in WRITING_TESTS for optimization in [
    "O0",
    "O2",
]]

COMPARED = [group + "-" + name + ".o" for group, name, source, flags in LIBRARY_OBJECTS] + ["lib" + library + ".a" for library in ARCHIVES]

[command_test(
    name = "compare-" + name,
    args = [
        "$(location :stage2-" + name + ")",
        "$(location :stage3-" + name + ")",
    ],
    tool = "cellar//bootstrap/stage0-posix/cellar-extra:bytecmp",
) for name in COMPARED]

filegroup(
    name = "stage-comparison",
    srcs = {},
    tests = [":compare-" + name for name in COMPARED],
)

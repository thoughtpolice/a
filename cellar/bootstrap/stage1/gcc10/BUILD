# SPDX-FileCopyrightText: 2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

load("@cellar//bootstrap:actions.bzl", "command_test", "concatenate", "configured_tool", "generate")
load("@cellar//bootstrap:defs.bzl", "export_file", "filegroup")
load("@cellar//bootstrap:source.bzl", "download_file", "exact_patch", "untar", "write_file")
load("@cellar//bootstrap/stage1:defs.bzl", "c_binary", "c_library", "c_object", "compiler", "sysroot")
load(":config.bzl", "mkconfig")
load(":sources.bzl", "BACKEND_OBJECTS", "CC_SOURCES", "COMMON_OBJECTS", "COMMON_TARGET_OBJECTS", "CXX_OBJECTS", "C_OBJECTS", "GCC_FILES", "GENERATED_COMPILER_SOURCES", "GTYPE_INPUTS", "GTYPE_OUTPUTS", "LIBCPP_FILES", "LIBDECNUMBER_FILES", "LIBGCC_OBJECTS", "LIBGCOV_OBJECTS")

GCC47 = "cellar//bootstrap/stage1/gcc47"

LIBSTDCXX47 = "cellar//bootstrap/stage1/libstdcxx"

MUSL = "cellar//bootstrap/stage1/musl12"

SOURCE_ALIAS = "cellar//bootstrap/stage1/tools:source-alias"

CAPTURE = "cellar//bootstrap/stage1/tools:capture"

SED = "cellar//bootstrap/stage1/sed:sed"

CMP = "cellar//bootstrap/stage0-posix/cellar-extra:bytecmp"

CATM = "cellar//bootstrap/stage0-posix/mescc-tools-extra:catm"

EXPECT_EXIT = "cellar//bootstrap/stage1/tools:expect-exit"

download_file(
    name = "gcc-10.5.0.tar.xz",
    hash = "25109543fdf46f397c347b5d8b7a2c7e5694a5a51cce4b9c6e1ea8a71ca307c1",
    size_bytes = 77846412,
    urls = ["https://mirrors.kernel.org/gnu/gcc/gcc-10.5.0/gcc-10.5.0.tar.xz"],
)

generate(
    name = "gcc.tar",
    args = [
        "--file",
        "$(location :gcc-10.5.0.tar.xz)",
        "--output",
    ],
    tool = "cellar//bootstrap/stage0-posix/mescc-tools-extra:unxz",
)

# Small support directories are projected whole. The gcc, libcpp and
# libdecnumber trees use manifests that withhold the files BUILD regenerates.
SOURCE_DIRECTORIES = [
    "contrib/unicode",
    "include",
    "libbacktrace",
    "libcpp",
    "libdecnumber",
    "libgcc",
    "libiberty",
    "libstdc++-v3",
]

GENERATOR_INPUTS = [
    "libcpp/makeucnid.c",
    "libcpp/ucnid.tab",
    "libiberty/crc32.c",
    "libiberty/make-temp-file.c",
    "libbacktrace/backtrace-supported.h.in",
    "libbacktrace/backtrace.h",
    "libgcc/config/i386/linux-unwind.h",
    "libgcc/config/i386/sfp-machine.h",
    "libgcc/gthr-posix.h",
    "libgcc/enable-execute-stack-empty.c",
    "libgcc/gcov.h",
    "libgcc/unwind-generic.h",
    "contrib/unicode/UnicodeData.txt",
    "contrib/unicode/EastAsianWidth.txt",
    "contrib/unicode/PropList.txt",
    "gcc/gengtype-lex.l",
    "gcc/genmatch.c",
    "gcc/cp/cfns.gperf",
    "gcc/gen-pass-instances.awk",
    "gcc/passes.def",
    "gcc/config/i386/i386-passes.def",
    "gcc/config/i386/i386-builtin-types.awk",
    "gcc/config/i386/i386-builtin-types.def",
]

# Shipped generated files are comparison fixtures, never compiler inputs.
FIXTURES = [
    "libcpp/ucnid.h",
    "libcpp/generated_cpp_wcwidth.h",
    "libdecnumber/decDPD.h",
    "libdecnumber/bid/bid2dpd_dpd2bid.h",
    "gcc/gengtype-lex.c",
    "gcc/cp/cfns.h",
]

untar(
    name = "gcc-10.5.0",
    chdirenv = "cellar//bootstrap/stage0-posix/cellar-extra:chdirenv",
    files = SOURCE_DIRECTORIES + GENERATOR_INPUTS + FIXTURES + LIBCPP_FILES + LIBDECNUMBER_FILES + GCC_FILES + [
        "COPYING.RUNTIME",
        "COPYING3",
        "COPYING3.LIB",
    ],
    flags = ["-xf"],
    input = ":gcc.tar",
    # GCC 10 archives use pax records, including for long member names.
    untar = "cellar//bootstrap/stage1/pax:untar",
)

# GCC 10 is written in C++98. The final GCC 4.7 stage and its C++ library
# build the first GCC 10 stage; each later stage uses its predecessor.
REPRODUCIBLE_FLAGS = [
    "-frandom-seed=bootstrap",
    "-g0",
    "-Wno-builtin-macro-redefined",
    '-D__DATE__="Jan  1 1970"',
    '-D__TIME__="00:00:00"',
    '-D__TIMESTAMP__="Thu Jan  1 00:00:00 1970"',
]

compiler(
    name = "gcc47-g++",
    abi = "x86_64-sysv",
    archive_flags = ["crsD"],
    archive_format = "ar",
    archiver = "cellar//bootstrap/stage1/binutils:ar",
    cflags = REPRODUCIBLE_FLAGS,
    compiler = LIBSTDCXX47 + ":stage3-g++",
    execution_runtime = MUSL + ":runtime",
    family = "gcc",
    ldflags = ["-static"],
    linker = "cellar//bootstrap/stage1/binutils:ld",
    object_format = "elf64-x86-64",
    stage = "gcc-4.7.4-stage3-c++",
    sysroot = GCC47 + ":stage3-runtime",
    target_compatible_with = [
        "cellar//bootstrap/platforms:linux",
        "cellar//bootstrap/platforms:amd64",
    ],
)

# Every compiler stage instantiates the generators and support libraries anew.
# Host programs link their predecessor's C runtime and C++ library; target
# libraries below are built by, and belong to, the newly built compiler.
STAGES = [
    "stage1",
    "stage2",
    "stage3",
]

PREDECESSOR = {
    "stage2": "stage1",
    "stage3": "stage2",
}

LIBSTDCXX10 = "cellar//bootstrap/stage1/libstdcxx10"

HOST_CC = {"stage1": GCC47 + ":stage3-gcc"} | {stage: ":" + previous + "-gcc" for stage, previous in PREDECESSOR.items()}

HOST_CXX = {"stage1": ":gcc47-g++"} | {stage: ":" + previous + "-host-g++" for stage, previous in PREDECESSOR.items()}

HOST_PREFIX = {"stage1": GCC47 + ":stage3-"} | {stage: ":" + previous + "-" for stage, previous in PREDECESSOR.items()}

HOST_CRT = {stage: [
    MUSL + ":crt1.o",
    MUSL + ":crti.o",
    prefix + "crtbeginT.o",
] for stage, prefix in HOST_PREFIX.items()}

HOST_CRTN = {stage: [
    prefix + "crtend.o",
    MUSL + ":crtn.o",
] for stage, prefix in HOST_PREFIX.items()}

HOST_LIBC = {stage: [
    MUSL + ":libc.a",
    prefix + "libgcc.a",
    MUSL + ":libc.a",
] for stage, prefix in HOST_PREFIX.items()}

# C++ programs also link the predecessor's standard library.
HOST_LIBCXX = {"stage1": [LIBSTDCXX47 + ":stage3-libstdc++.a"] + HOST_LIBC["stage1"]} | {
    stage: [LIBSTDCXX10 + ":" + previous + "-libstdc++.a"] + HOST_LIBC[stage]
    for stage, previous in PREDECESSOR.items()
}

[
    download_file(
        name = name + "-6.3.0.txt",
        hash = digest,
        size_bytes = size,
        urls = ["https://www.unicode.org/Public/6.3.0/ucd/" + name + ".txt"],
    )
    for name, digest, size in [
        ("UnicodeData", "3f76924f0410ca8ae0e9b5c59bd1ba03196293c32616204b393300f091f52013", 1367023),
        ("DerivedNormalizationProps", "c5e867ae043fe5d1cf713150d859356bfdcdba291c39f584af0bfb943f1a9743", 783470),
    ]
]

[
    generate(
        name = name,
        args = args + ["$(location :gcc-10.5.0[libiberty/crc32.c])"],
        capture = CAPTURE,
        output = name,
        tool = SED,
    )
    for name, args in [
        (
            "crc-generator.c",
            [
                "-n",
                "/^   #include <stdio.h>/,/^   }/p",
            ],
        ),
        (
            "crc-prefix.c",
            ["/crc_v3\\.txt/{n;q;}"],
        ),
        (
            "crc-suffix.c",
            ["1,/^};$/d"],
        ),
    ]
]

# The final flush must not read the entry one past the code-point tables.
exact_patch(
    name = "makeucnid.c",
    src = ":gcc-10.5.0[libcpp/makeucnid.c]",
    after = "\tif (i == NUM_CODE_POINTS) break;\n\tlast_flag = flags[i];",
    before = "\tlast_flag = flags[i];",
    output = "makeucnid.c",
)

export_file(name = "generators/wcwidth.c")

# The GCC 13 port runs these tests too.
[export_file(name = path) for path in glob(["tests/*"])]

filegroup(
    name = "generator-source",
    srcs = {
        "makeucnid.c": ":makeucnid.c",
        "crc-generator.c": ":crc-generator.c",
        "decDPD.c": GCC47 + ":generators/decDPD.c",
        "wcwidth.c": ":generators/wcwidth.c",
    },
)

[
    [
        c_object(
            name = stage + "-gen-" + name + ".o",
            src = ":generator-source[" + name + ".c]",
            flags = [
                "-O2",
                "-std=gnu99",
                "-Werror",
            ],
            logical_source = name + ".c",
            source_alias = SOURCE_ALIAS,
            source_tree = ":generator-source",
            toolchain = HOST_CC[stage],
        ),
        c_binary(
            name = stage + "-gen-" + name,
            end_objects = HOST_CRTN[stage],
            libraries = HOST_LIBC[stage],
            objects = HOST_CRT[stage] + [":" + stage + "-gen-" + name + ".o"],
            toolchain = HOST_CC[stage],
        ),
    ]
    for stage in STAGES
    for name in [
        "makeucnid",
        "crc-generator",
        "decDPD",
        "wcwidth",
    ]
]

[
    [
        generate(
            name = stage + "-ucnid.h",
            args = [
                "$(location :gcc-10.5.0[libcpp/ucnid.tab])",
                "$(location :UnicodeData-6.3.0.txt)",
                "$(location :DerivedNormalizationProps-6.3.0.txt)",
            ],
            capture = CAPTURE,
            output = "ucnid.h",
            tool = ":" + stage + "-gen-makeucnid",
        ),
        generate(
            name = stage + "-generated_cpp_wcwidth.h",
            args = [
                "12.1.0",
                "$(location :gcc-10.5.0[contrib/unicode/UnicodeData.txt])",
                "$(location :gcc-10.5.0[contrib/unicode/EastAsianWidth.txt])",
                "$(location :gcc-10.5.0[contrib/unicode/PropList.txt])",
            ],
            capture = CAPTURE,
            output = "generated_cpp_wcwidth.h",
            tool = ":" + stage + "-gen-wcwidth",
        ),
        generate(
            name = stage + "-crc-table.c",
            capture = CAPTURE,
            tool = ":" + stage + "-gen-crc-generator",
        ),
        concatenate(
            name = stage + "-crc32.c",
            inputs = [
                ":crc-prefix.c",
                ":" + stage + "-crc-table.c",
                ":crc-suffix.c",
            ],
            output = "crc32.c",
            tool = CATM,
        ),
        generate(
            name = stage + "-decimal-tables",
            capture = CAPTURE,
            tool = ":" + stage + "-gen-decDPD",
        ),
        concatenate(
            name = stage + "-decDPD.h",
            inputs = [
                GCC47 + ":generators/decDPD.preamble",
                ":" + stage + "-decimal-tables",
            ],
            output = "decDPD.h",
            tool = CATM,
        ),
    ]
    for stage in STAGES
]

[
    command_test(
        name = stage + "-" + name + "-regeneration",
        args = [
            "$(location :" + stage + "-" + generated + ")",
            "$(location :gcc-10.5.0[" + fixture + "])",
        ],
        tool = CMP,
    )
    for stage in STAGES
    for name, generated, fixture in [
        ("unicode", "ucnid.h", "libcpp/ucnid.h"),
        ("wcwidth", "generated_cpp_wcwidth.h", "libcpp/generated_cpp_wcwidth.h"),
        ("crc", "crc32.c", "libiberty/crc32.c"),
    ]
]

# The DPD generator, preamble and BID generator are shared with GCC 4.7; the
# tables are unchanged. Values are compared, so updated notices do not matter.
[
    [
        filegroup(
            name = "decimal-" + kind,
            srcs = {
                "decDPD.h": header,
                "decDPDSymbols.h": ":gcc-10.5.0[libdecnumber/decDPDSymbols.h]",
            },
        ),
        c_object(
            name = "decimal-" + kind + ".o",
            src = "tests/decimal-tables.c",
            flags = [
                "-O2",
                "-Werror",
            ],
            headers = [":decimal-" + kind],
            includes = [":decimal-" + kind],
            toolchain = HOST_CC["stage1"],
        ),
        c_binary(
            name = "decimal-" + kind + "-program",
            end_objects = HOST_CRTN["stage1"],
            libraries = HOST_LIBC["stage1"],
            objects = HOST_CRT["stage1"] + [":decimal-" + kind + ".o"],
            toolchain = HOST_CC["stage1"],
        ),
        generate(
            name = "decimal-" + kind + "-values",
            capture = CAPTURE,
            tool = ":decimal-" + kind + "-program",
        ),
    ]
    for kind, header in [(
        stage + "-regenerated",
        ":" + stage + "-decDPD.h",
    ) for stage in STAGES] + [
        ("fixture", ":gcc-10.5.0[libdecnumber/decDPD.h]"),
    ]
]

[command_test(
    name = stage + "-decimal-regeneration",
    args = [
        "$(location :decimal-" + stage + "-regenerated-values)",
        "$(location :decimal-fixture-values)",
    ],
    tool = CMP,
) for stage in STAGES]

generate(
    name = "bid-preamble",
    args = [
        "/^static const UINT128 reciprocals10_128/,$d",
        "$(location :gcc-10.5.0[libdecnumber/bid/bid2dpd_dpd2bid.h])",
    ],
    capture = CAPTURE,
    tool = SED,
)

[
    [
        filegroup(
            name = stage + "-bid-generator-source",
            srcs = {
                "bid-tables.c": GCC47 + ":generators/bid-tables.c",
                "decDPD.h": ":" + stage + "-decDPD.h",
                "decDPDSymbols.h": ":gcc-10.5.0[libdecnumber/decDPDSymbols.h]",
            },
        ),
        c_object(
            name = stage + "-gen-bid.o",
            src = ":" + stage + "-bid-generator-source[bid-tables.c]",
            flags = [
                "-O2",
                "-Werror",
            ],
            includes = ["cellar//bootstrap/stage1/gmp:headers"],
            logical_source = "bid-tables.c",
            source_alias = SOURCE_ALIAS,
            source_tree = ":" + stage + "-bid-generator-source",
            toolchain = HOST_CC[stage],
        ),
        c_binary(
            name = stage + "-gen-bid",
            end_objects = HOST_CRTN[stage],
            libraries = ["cellar//bootstrap/stage1/gmp:libgmp.a"] + HOST_LIBC[stage],
            objects = HOST_CRT[stage] + [":" + stage + "-gen-bid.o"],
            toolchain = HOST_CC[stage],
        ),
        generate(
            name = stage + "-bid-tables",
            capture = CAPTURE,
            tool = ":" + stage + "-gen-bid",
        ),
        concatenate(
            name = stage + "-bid2dpd_dpd2bid.h",
            inputs = [
                ":bid-preamble",
                ":" + stage + "-bid-tables",
            ],
            output = "bid2dpd_dpd2bid.h",
            tool = CATM,
        ),
    ]
    for stage in STAGES
]

[
    [
        filegroup(
            name = "bid-" + kind,
            srcs = {"bid2dpd_dpd2bid.h": header},
        ),
        c_object(
            name = "bid-" + kind + ".o",
            src = "tests/bid-tables.c",
            flags = [
                "-O2",
                "-Werror",
            ],
            includes = [":bid-" + kind],
            toolchain = HOST_CC["stage1"],
        ),
        c_binary(
            name = "bid-" + kind + "-program",
            end_objects = HOST_CRTN["stage1"],
            libraries = HOST_LIBC["stage1"],
            objects = HOST_CRT["stage1"] + [":bid-" + kind + ".o"],
            toolchain = HOST_CC["stage1"],
        ),
        generate(
            name = "bid-" + kind + "-values",
            capture = CAPTURE,
            tool = ":bid-" + kind + "-program",
        ),
    ]
    for kind, header in [(
        stage + "-regenerated",
        ":" + stage + "-bid2dpd_dpd2bid.h",
    ) for stage in STAGES] + [
        ("fixture", ":gcc-10.5.0[libdecnumber/bid/bid2dpd_dpd2bid.h]"),
    ]
]

[command_test(
    name = stage + "-bid-regeneration",
    args = [
        "$(location :bid-" + stage + "-regenerated-values)",
        "$(location :bid-fixture-values)",
    ],
    tool = CMP,
) for stage in STAGES]

# Upstream REQUIRED_OFILES, libcpp_a_OBJS, native BID libdecnumber objects and
# the ELF/mmap libbacktrace configuration.
LIBIBERTY = [
    "regex",
    "cplus-dem",
    "cp-demangle",
    "md5",
    "sha1",
    "alloca",
    "argv",
    "choose-temp",
    "concat",
    "cp-demint",
    "crc32",
    "d-demangle",
    "dwarfnames",
    "dyn-string",
    "fdmatch",
    "fibheap",
    "filedescriptor",
    "filename_cmp",
    "floatformat",
    "fnmatch",
    "fopen_unlocked",
    "getopt",
    "getopt1",
    "getpwd",
    "getruntime",
    "hashtab",
    "hex",
    "lbasename",
    "lrealpath",
    "make-relative-prefix",
    "make-temp-file",
    "objalloc",
    "obstack",
    "partition",
    "pexecute",
    "physmem",
    "pex-common",
    "pex-one",
    "pex-unix",
    "vprintf-support",
    "rust-demangle",
    "safe-ctype",
    "simple-object",
    "simple-object-coff",
    "simple-object-elf",
    "simple-object-mach-o",
    "simple-object-xcoff",
    "sort",
    "spaces",
    "splay-tree",
    "stack-limit",
    "strerror",
    "strsignal",
    "timeval-utils",
    "unlink-if-ordinary",
    "xasprintf",
    "xatexit",
    "xexit",
    "xmalloc",
    "xmemdup",
    "xstrdup",
    "xstrerror",
    "xstrndup",
    "xvasprintf",
]

LIBCPP = [
    "charset",
    "directives",
    "directives-only",
    "errors",
    "expr",
    "files",
    "identifiers",
    "init",
    "lex",
    "line-map",
    "macro",
    "mkdeps",
    "pch",
    "symtab",
    "traditional",
]

LIBDECNUMBER = [
    "decNumber",
    "decContext",
    "bid/decimal32",
    "bid/decimal64",
    "bid/decimal128",
    "bid/bid2dpd_dpd2bid",
    "bid/host-ieee32",
    "bid/host-ieee64",
    "bid/host-ieee128",
]

LIBBACKTRACE = [
    "atomic",
    "dwarf",
    "fileline",
    "posix",
    "print",
    "sort",
    "state",
    "backtrace",
    "simple",
    "elf",
    "mmapio",
    "mmap",
]

# Reviewed native LP64 GCC/musl features; no NLS, host obstacks or tuning probes.
LIBRARY_CONFIG_ON = [
    "STDC_HEADERS",
    "TIME_WITH_SYS_TIME",
    "STRING_WITH_STRINGS",
    "HAVE_ALLOCA",
    "HAVE_ALLOCA_H",
    "HAVE_ASPRINTF",
    "HAVE_ATEXIT",
    "HAVE_BASENAME",
    "HAVE_BCMP",
    "HAVE_BCOPY",
    "HAVE_BSEARCH",
    "HAVE_BZERO",
    "HAVE_CALLOC",
    "HAVE_CLOCK",
    "HAVE_FCNTL_H",
    "HAVE_FFS",
    "HAVE_FORK",
    "HAVE_GETCWD",
    "HAVE_GETPAGESIZE",
    "HAVE_GETRUSAGE",
    "HAVE_GETTIMEOFDAY",
    "HAVE_INDEX",
    "HAVE_INSQUE",
    "HAVE_INTTYPES_H",
    "HAVE_LIMITS_H",
    "HAVE_LONG_LONG",
    "HAVE_MALLOC_H",
    "HAVE_MEMCHR",
    "HAVE_MEMCMP",
    "HAVE_MEMCPY",
    "HAVE_MEMMOVE",
    "HAVE_MEMORY_H",
    "HAVE_MEMPCPY",
    "HAVE_MEMSET",
    "HAVE_MKSTEMPS",
    "HAVE_MMAP",
    "HAVE_PSIGNAL",
    "HAVE_PUTENV",
    "HAVE_RANDOM",
    "HAVE_REALPATH",
    "HAVE_RENAME",
    "HAVE_RINDEX",
    "HAVE_SBRK",
    "HAVE_SETENV",
    "HAVE_SNPRINTF",
    "HAVE_STDDEF_H",
    "HAVE_STDINT_H",
    "HAVE_STDIO_EXT_H",
    "HAVE_STDLIB_H",
    "HAVE_STPCPY",
    "HAVE_STPNCPY",
    "HAVE_STRCASECMP",
    "HAVE_STRCHR",
    "HAVE_STRDUP",
    "HAVE_STRERROR",
    "HAVE_STRINGS_H",
    "HAVE_STRING_H",
    "HAVE_STRNCASECMP",
    "HAVE_STRNLEN",
    "HAVE_STRRCHR",
    "HAVE_STRSIGNAL",
    "HAVE_STRSTR",
    "HAVE_STRTOD",
    "HAVE_STRTOL",
    "HAVE_STRTOLL",
    "HAVE_STRTOUL",
    "HAVE_STRTOULL",
    "HAVE_SYSCONF",
    "HAVE_SYS_FILE_H",
    "HAVE_SYS_MMAN_H",
    "HAVE_SYS_RESOURCE_H",
    "HAVE_SYS_STAT_H",
    "HAVE_SYS_SYSINFO_H",
    "HAVE_SYS_TIME_H",
    "HAVE_SYS_TYPES_H",
    "HAVE_SYS_WAIT_H",
    "HAVE_TIMES",
    "HAVE_TIME_H",
    "HAVE_TMPNAM",
    "HAVE_UINTPTR_T",
    "HAVE_UNISTD_H",
    "HAVE_VASPRINTF",
    "HAVE_VFORK",
    "HAVE_VFPRINTF",
    "HAVE_VPRINTF",
    "HAVE_VSNPRINTF",
    "HAVE_VSPRINTF",
    "HAVE_WAITPID",
    "HAVE_WORKING_FORK",
    "HAVE_WORKING_VFORK",
    "HAVE___FSETLOCKING",
    "HAVE_DECL_ABORT",
    "HAVE_DECL_ERRNO",
    "HAVE_DECL_GETOPT",
    "HAVE_ICONV",
    "HAVE_ICONV_H",
    "HAVE_LANGINFO_CODESET",
    "HAVE_LOCALE_H",
    "HAVE_CLEARERR_UNLOCKED",
    "HAVE_DECL_CLEARERR_UNLOCKED",
    "HAVE_FEOF_UNLOCKED",
    "HAVE_DECL_FEOF_UNLOCKED",
    "HAVE_FERROR_UNLOCKED",
    "HAVE_DECL_FERROR_UNLOCKED",
    "HAVE_FFLUSH_UNLOCKED",
    "HAVE_DECL_FFLUSH_UNLOCKED",
    "HAVE_FGETC_UNLOCKED",
    "HAVE_DECL_FGETC_UNLOCKED",
    "HAVE_FGETS_UNLOCKED",
    "HAVE_DECL_FGETS_UNLOCKED",
    "HAVE_FILENO_UNLOCKED",
    "HAVE_DECL_FILENO_UNLOCKED",
    "HAVE_FPUTC_UNLOCKED",
    "HAVE_DECL_FPUTC_UNLOCKED",
    "HAVE_FPUTS_UNLOCKED",
    "HAVE_DECL_FPUTS_UNLOCKED",
    "HAVE_FREAD_UNLOCKED",
    "HAVE_DECL_FREAD_UNLOCKED",
    "HAVE_FWRITE_UNLOCKED",
    "HAVE_DECL_FWRITE_UNLOCKED",
    "HAVE_GETCHAR_UNLOCKED",
    "HAVE_DECL_GETCHAR_UNLOCKED",
    "HAVE_GETC_UNLOCKED",
    "HAVE_DECL_GETC_UNLOCKED",
    "HAVE_PUTCHAR_UNLOCKED",
    "HAVE_DECL_PUTCHAR_UNLOCKED",
    "HAVE_PUTC_UNLOCKED",
    "HAVE_DECL_PUTC_UNLOCKED",
    "HAVE_CTYPE_H",
    "HAVE_STDIO_H",
    "HAVE_INTPTR_T",
    "HAVE_MEMMEM",
    "HAVE_STRNDUP",
    "HAVE_STRVERSCMP",
    "HAVE_GETRLIMIT",
    "HAVE_SETRLIMIT",
    "HAVE_WAIT3",
    "HAVE_WAIT4",
    "HAVE_DUP3",
    "HAVE_PIPE2",
    "HAVE_DECL_ASPRINTF",
    "HAVE_DECL_CALLOC",
    "HAVE_DECL_FFS",
    "HAVE_DECL_GETENV",
    "HAVE_DECL_MALLOC",
    "HAVE_DECL_REALLOC",
    "HAVE_DECL_SBRK",
    "HAVE_DECL_SNPRINTF",
    "HAVE_DECL_STRNLEN",
    "HAVE_DECL_STRTOL",
    "HAVE_DECL_STRTOLL",
    "HAVE_DECL_STRTOUL",
    "HAVE_DECL_STRTOULL",
    "HAVE_DECL_STRVERSCMP",
    "HAVE_DECL_VASPRINTF",
    "HAVE_DECL_VSNPRINTF",
    "ENABLE_ASSERT_CHECKING",
    "ENABLE_CANONICAL_SYSTEM_HEADERS",
]

LIBRARY_CONFIG_VALUES = {
    "SIZEOF_INT": "4",
    "SIZEOF_LONG": "8",
    "SIZEOF_LONG_LONG": "8",
    "SIZEOF_SIZE_T": "8",
    "SIZEOF_VOID_P": "8",
    "STACK_DIRECTION": "-1",
    "UNSIGNED_64BIT_TYPE": "unsigned long",
    "ICONV_CONST": "",
    "PACKAGE": "\"gcc\"",
    "PACKAGE_VERSION": "\"10.5.0\"",
    "SIZEOF_CHAR": "1",
    "SIZEOF_SHORT": "2",
    "HAVE_DECL_FPRINTF_UNLOCKED": "0",
    # musl 1.2.5 declares basename only in <libgen.h>, so libiberty.h
    # declares it. HAVE_BASENAME leaves libiberty's GNU basename unbuilt, so
    # callers get musl's POSIX function, as in an upstream musl build.
    "HAVE_DECL_BASENAME": "0",
    # Release checking: assertions stay enabled, extra checks do not.
    "CHECKING_P": "0",
}

write_file(
    name = "library-config.h",
    content = "#ifndef GCC10_LIBRARY_CONFIG_H\n#define GCC10_LIBRARY_CONFIG_H 1\n#ifndef _GNU_SOURCE\n#define _GNU_SOURCE 1\n#endif\n" + "\n".join(["#define " + name + " 1" for name in LIBRARY_CONFIG_ON]) + "\n" + "\n".join(["#define " + name + " " + value for name, value in LIBRARY_CONFIG_VALUES.items()]) + "\n#endif\n",
)

BACKTRACE_CONFIG_ON = [
    "HAVE_ATOMIC_FUNCTIONS",
    "HAVE_CLOCK_GETTIME",
    "HAVE_DLFCN_H",
    "HAVE_DL_ITERATE_PHDR",
    "HAVE_FCNTL",
    "HAVE_GETIPINFO",
    "HAVE_INTTYPES_H",
    "HAVE_LINK_H",
    "HAVE_LSTAT",
    "HAVE_MEMORY_H",
    "HAVE_READLINK",
    "HAVE_STDINT_H",
    "HAVE_STDLIB_H",
    "HAVE_STRINGS_H",
    "HAVE_STRING_H",
    "HAVE_SYNC_FUNCTIONS",
    "HAVE_SYS_MMAN_H",
    "HAVE_SYS_STAT_H",
    "HAVE_SYS_TYPES_H",
    "HAVE_UNISTD_H",
    "STDC_HEADERS",
]

write_file(
    name = "backtrace-config.h",
    content = "#ifndef _GNU_SOURCE\n#define _GNU_SOURCE 1\n#endif\n" + "\n".join(["#define " + name + " 1" for name in BACKTRACE_CONFIG_ON]) + "\n#define HAVE_DECL_STRNLEN 1\n#define BACKTRACE_ELF_SIZE 64\n#define SIZEOF_CHAR 1\n#define SIZEOF_INT 4\n#define SIZEOF_LONG 8\n#define SIZEOF_SHORT 2\n#define SIZEOF_VOID_P 8\n",
)

# Native ELF lookup with mmap allocation, POSIX threads and data symbols.
generate(
    name = "backtrace-supported.h",
    args = [
        "-e",
        "s/@BACKTRACE_SUPPORTED@/1/",
        "-e",
        "s/@BACKTRACE_USES_MALLOC@/0/",
        "-e",
        "s/@BACKTRACE_SUPPORTS_THREADS@/1/",
        "-e",
        "s/@BACKTRACE_SUPPORTS_DATA@/1/",
        "$(location :gcc-10.5.0[libbacktrace/backtrace-supported.h.in])",
    ],
    capture = CAPTURE,
    output = "backtrace-supported.h",
    tool = SED,
)

write_file(
    name = "localedir.h",
    content = '#define LOCALEDIR "/nonexistent-bootstrap-locale"\n',
)

write_file(
    name = "gstdint.h",
    content = "#include <stdint.h>\n",
)

# The GCC 4.7 port's temporary directory change applies unchanged.
exact_patch(
    name = "make-temp-file.c",
    src = ":gcc-10.5.0[libiberty/make-temp-file.c]",
    output = "make-temp-file.c",
    patch = GCC47 + ":patches/tmpdir.patch",
)

# Shipped sources are projected whole where no sibling includes a regenerated
# file. Build-only headers and replacement sources live under build/.
[
    filegroup(
        name = stage + "-library-source",
        srcs = {path: ":gcc-10.5.0[" + path + "]" for path in LIBCPP_FILES + LIBDECNUMBER_FILES} | {
            "gcc/config/i386/cpuid.h": ":gcc-10.5.0[gcc/config/i386/cpuid.h]",
            "include": ":gcc-10.5.0[include]",
            "libiberty": ":gcc-10.5.0[libiberty]",
            "libbacktrace": ":gcc-10.5.0[libbacktrace]",
            "libcpp/config.h": ":library-config.h",
            "libcpp/localedir.h": ":localedir.h",
            "libcpp/ucnid.h": ":" + stage + "-ucnid.h",
            "libcpp/generated_cpp_wcwidth.h": ":" + stage + "-generated_cpp_wcwidth.h",
            "libdecnumber/config.h": ":library-config.h",
            "libdecnumber/gstdint.h": ":gstdint.h",
            "libdecnumber/decDPD.h": ":" + stage + "-decDPD.h",
            "libdecnumber/bid/bid2dpd_dpd2bid.h": ":" + stage + "-bid2dpd_dpd2bid.h",
            "build/libiberty/config.h": ":library-config.h",
            "build/libiberty/crc32.c": ":" + stage + "-crc32.c",
            "build/libiberty/make-temp-file.c": ":make-temp-file.c",
            "build/libbacktrace/config.h": ":backtrace-config.h",
            "build/libbacktrace/backtrace-supported.h": ":backtrace-supported.h",
            "build/libbacktrace/unwind.h": ":gcc-10.5.0[libgcc/unwind-generic.h]",
        },
    )
    for stage in STAGES
]

LIBRARIES = {
    "libiberty": (
        LIBIBERTY,
        "c",
        [
            "build/libiberty",
            "libiberty",
            "include",
        ],
    ),
    "libcpp": (
        LIBCPP,
        "c++",
        [
            "libcpp",
            "libcpp/include",
            "include",
        ],
    ),
    "libdecnumber": (
        LIBDECNUMBER,
        "c",
        [
            "libdecnumber",
            "libdecnumber/bid",
        ],
    ),
    "libbacktrace": (
        LIBBACKTRACE,
        "c",
        [
            "build/libbacktrace",
            "libbacktrace",
            "include",
        ],
    ),
}

LIBRARY_BUILD_SOURCES = [
    "libiberty/crc32",
    "libiberty/make-temp-file",
]

LANGUAGE_FLAGS = {
    "c": [],
    # GCC 10's host code needs no exceptions or RTTI. Like upstream, each
    # stage keeps its compiler's default dialect: gnu++98 for GCC 4.7 and
    # gnu++14 for GCC 10.
    "c++": [
        "-x",
        "c++",
        "-fno-exceptions",
        "-fno-rtti",
        # Upstream's warning flags accept narrowing in initializers, which
        # C++11 and later dialects otherwise reject.
        "-Wno-narrowing",
    ],
}

[
    c_object(
        name = stage + "-" + library + "-" + name.replace("/", "-") + ".o",
        src = ":" + stage + "-library-source",
        defines = ["HAVE_CONFIG_H=1"],
        flags = LANGUAGE_FLAGS[language] + [
            "-O2",
            "-Werror",
        ] + (["-funwind-tables"] if library == "libbacktrace" else []),
        logical_includes = includes,
        logical_source = ("build/" if library + "/" + name in LIBRARY_BUILD_SOURCES else "") + library + "/" + name + ".c",
        object_name = library + str(i) + ".o",
        source_alias = SOURCE_ALIAS,
        source_tree = ":" + stage + "-library-source",
        toolchain = HOST_CXX[stage] if language == "c++" else HOST_CC[stage],
    )
    for stage in STAGES
    for library, (sources, language, includes) in LIBRARIES.items()
    for i, name in enumerate(sources)
]

[
    c_library(
        name = stage + "-" + library + ".a",
        objects = [":" + stage + "-" + library + "-" + name.replace("/", "-") + ".o" for name in sources],
        output = library + ".a",
        toolchain = HOST_CC[stage],
    )
    for stage in STAGES
    for library, (sources, language, includes) in LIBRARIES.items()
]

[
    [
        c_object(
            name = name + "-test.o",
            src = "tests/" + source,
            flags = LANGUAGE_FLAGS[language] + [
                "-O2",
                "-Werror",
            ],
            # do not sort
            includes = [
                ":stage1-library-source[libcpp]",
                ":stage1-library-source[libcpp/include]",
                ":stage1-library-source[include]",
                ":stage1-library-source[libdecnumber]",
                ":stage1-library-source[libdecnumber/bid]",
            ] if name != "libiberty" else [
                ":stage1-library-source[build/libiberty]",
                ":stage1-library-source[include]",
            ],
            toolchain = HOST_CXX["stage1"] if language == "c++" else HOST_CC["stage1"],
        ),
        c_binary(
            name = name + "-test-bin",
            end_objects = HOST_CRTN["stage1"],
            libraries = [
                ":stage1-libcpp.a",
                ":stage1-libiberty.a",
                ":stage1-libdecnumber.a",
            ] + (HOST_LIBCXX["stage1"] if language == "c++" else HOST_LIBC["stage1"]),
            objects = HOST_CRT["stage1"] + [":" + name + "-test.o"],
            toolchain = HOST_CC["stage1"],
        ),
    ]
    for name, source, language in [
        ("libiberty", "libiberty.c", "c"),
        ("cpp", "cpp.cc", "c++"),
        ("decimal", "decimal.c", "c"),
    ]
]

command_test(
    name = "libiberty-test",
    tool = ":libiberty-test-bin",
)

command_test(
    name = "decimal-arithmetic",
    tool = ":decimal-test-bin",
)

generate(
    name = "libiberty-temp-run",
    args = ["temp"],
    chdir = "cellar//bootstrap/stage0-posix/cellar-extra:chdirenv",
    directory = True,
    env = {"TMPDIR": "."},
    files = ["passed"],
    tool = ":libiberty-test-bin",
)

write_file(
    name = "passed",
    content = "passed\n",
)

command_test(
    name = "libiberty-temp",
    args = [
        "$(location :libiberty-temp-run[passed])",
        "$(location :passed)",
    ],
    tool = CMP,
)

command_test(
    name = "libiberty-missing-tmpdir",
    args = [
        "1",
        "$(exe :libiberty-test-bin)",
        "temp",
    ],
    env = {"TMPDIR": "/nonexistent-bootstrap-tmp"},
    tool = EXPECT_EXIT,
)

filegroup(
    name = "cpp-fixtures",
    srcs = {
        "input.c": "cellar//bootstrap/stage1/gcc40:cpp-input.c",
        "included.h": "cellar//bootstrap/stage1/gcc40:included.h",
    },
)

generate(
    name = "cpp-result",
    args = ["$(location :cpp-fixtures[input.c])"],
    capture = CAPTURE,
    inputs = [":cpp-fixtures"],
    tool = ":cpp-test-bin",
)

command_test(
    name = "cpp-tokens",
    args = [
        "$(location :cpp-result)",
        "$(location cellar//bootstrap/stage1/gcc40:cpp-expected)",
    ],
    tool = CMP,
)

command_test(
    name = "cpp-missing-include",
    args = [
        "1",
        "$(exe :cpp-test-bin)",
        "$(location cellar//bootstrap/stage1/gcc40:cpp-bad.c)",
    ],
    tool = EXPECT_EXIT,
)

# gengtype's scanner is regenerated with the bootstrapped Flex 2.6.4, which
# also produced the shipped copy. Upstream prefixes the configuration include.
filegroup(
    name = "gengtype-scanner-source",
    srcs = {"gengtype-lex.l": ":gcc-10.5.0[gcc/gengtype-lex.l]"},
)

generate(
    name = "gengtype-scanner",
    args = [
        "-ogengtype-lex.c",
        "source/gengtype-lex.l",
    ],
    chdir = "cellar//bootstrap/stage0-posix/cellar-extra:chdirenv",
    directory = True,
    files = ["gengtype-lex.c"],
    source_alias = SOURCE_ALIAS,
    source_tree = ":gengtype-scanner-source",
    tool = "cellar//bootstrap/stage1/flex-final:flex",
)

write_file(
    name = "gengtype-lex-prefix",
    content = '#ifdef HOST_GENERATOR_FILE\n#include "config.h"\n#else\n#include "bconfig.h"\n#endif\n',
)

concatenate(
    name = "gengtype-lex.c",
    inputs = [
        ":gengtype-lex-prefix",
        ":gengtype-scanner[gengtype-lex.c]",
    ],
    output = "gengtype-lex.c",
    tool = CATM,
)

# The shipped scanner records the release manager's absolute source path.
[
    generate(
        name = "gengtype-lex-" + kind + ".normalized",
        args = [
            's|^#line \\([0-9]*\\) ".*gengtype-lex\\.l"$|#line \\1 "gengtype-lex.l"|',
            "$(location " + source + ")",
        ],
        capture = CAPTURE,
        tool = SED,
    )
    for kind, source in [
        ("regenerated", ":gengtype-lex.c"),
        ("fixture", ":gcc-10.5.0[gcc/gengtype-lex.c]"),
    ]
]

command_test(
    name = "gengtype-scanner-regeneration",
    args = [
        "$(location :gengtype-lex-regenerated.normalized)",
        "$(location :gengtype-lex-fixture.normalized)",
    ],
    tool = CMP,
)

# Reviewed GCC 10.5 native host, GNU binutils 2.30 and static musl 1.2.5
# target. Macros already set by library-config.h are omitted.
GCC_CONFIG_ON = [
    # Release checking (configure.ac:548-640 "release" row): assert and
    # runtime checks only. CHECKING_P=0 and ENABLE_ASSERT_CHECKING already
    # come from library-config.h.
    "ENABLE_RUNTIME_CHECKING",
    # --enable-decimal-float=bid (configure.ac:872-887).
    "ENABLE_DECIMAL_FLOAT",
    "ENABLE_DECIMAL_BID_FORMAT",
    # Upstream default; only consumed by the Fortran front end (configure.ac:6856-6863).
    "ENABLE_LIBQUADMATH_SUPPORT",
    # Host types and headers (C++ probes against musl and libstdc++).
    "HAVE_CLOCK_T",
    "HAVE_STRUCT_TMS",
    "HAVE_INTMAX_T",
    "HAVE_UINTMAX_T",
    "HAVE_LONG_LONG_INT",
    "HAVE_UNSIGNED_LONG_LONG_INT",
    "INT64_T_IS_LONG",
    "HAVE_SWAP_IN_UTILITY",
    "HAVE_SYS_PARAM_H",
    "HAVE_SYS_TIMES_H",
    "HAVE_LANGINFO_H",
    "HAVE_WCHAR_H",
    "HAVE_FTW_H",
    # From the libtool probe; only read under ENABLE_PLUGIN (system.h:684).
    "HAVE_DLFCN_H",
    # musl <termios.h> lacks TIOCGWINSZ; <sys/ioctl.h> has it (AC_HEADER_TIOCGWINSZ).
    "GWINSZ_IN_SYS_IOCTL",
    "HAVE_LC_MESSAGES",
    "HOST_HAS_F_SETLKW",
    # Host functions (configure.ac:1434-1437) musl provides.
    "HAVE_KILL",
    "HAVE_POPEN",
    "HAVE_NL_LANGINFO",
    "HAVE_MBSTOWCS",
    "HAVE_WORKING_MBSTOWCS",
    "HAVE_WCSWIDTH",
    "HAVE_SETLOCALE",
    "HAVE_MADVISE",
    "HAVE_MMAP_FILE",
    "HAVE_MMAP_ANON",
    "HAVE_MMAP_DEV_ZERO",
    # Target C library facts (configure.ac:6266-6317, 6448-6477).
    "TARGET_LIBC_PROVIDES_SSP",
    "TARGET_DL_ITERATE_PHDR",
    # GNU as 2.30, x86_64 ELF.
    "HAVE_GAS_BALIGN_AND_P2ALIGN",
    "HAVE_GAS_MAX_SKIP_P2ALIGN",
    "HAVE_GAS_SUBSECTION_ORDERING",
    "HAVE_GAS_WEAK",
    "HAVE_GAS_WEAKREF",
    "HAVE_GAS_HIDDEN",
    "HAVE_GAS_LOC_STMT",
    "HAVE_GAS_DISCRIMINATOR",
    # Only read by i386/bsd.h. GNU as accepts the 3-operand .lcomm on ELF.
    "HAVE_GAS_LCOMM_WITH_ALIGNMENT",
    "HAVE_AS_TLS",
    "HAVE_AS_DWARF2_DEBUG_LINE",
    # binutils 2.30 is the first release with .loc views; GCC emits
    # "view .LVUn" whenever -g is used, so check this with a gas test.
    "HAVE_AS_DWARF2_DEBUG_VIEW",
    "HAVE_AS_GDWARF2_DEBUG_FLAG",
    "HAVE_AS_GSTABS_DEBUG_FLAG",
    "HAVE_AS_DEBUG_PREFIX_MAP",
    "HAVE_AS_LINE_ZERO",
    "HAVE_AS_STABS_DIRECTIVE",
    "HAVE_AS_IX86_FILDS",
    "HAVE_AS_IX86_FILDQ",
    "HAVE_AS_IX86_FFREEP",
    "HAVE_AS_IX86_QUAD",
    "HAVE_AS_IX86_SAHF",
    "HAVE_AS_IX86_HLE",
    "HAVE_AS_IX86_SWAP",
    "HAVE_AS_IX86_DIFF_SECT_DELTA",
    "HAVE_AS_IX86_REP_LOCK_PREFIX",
    "HAVE_AS_IX86_UD2",
    # GNU ld 2.30.
    "HAVE_LD_EH_FRAME_HDR",
    "HAVE_LD_RO_RW_SECTION_MIXING",
    "HAVE_LD_STATIC_DYNAMIC",
    "HAVE_LD_DEMANGLE",
    "HAVE_LD_PIE",
    "HAVE_LD_EH_GC_SECTIONS",
    "HAVE_LD_AS_NEEDED",
    "HAVE_LD_BUILDID",
    "HAVE_LD_BNDPLT_SUPPORT",
    "HAVE_LD_PUSHPOPSTATE_SUPPORT",
]

GCC_CONFIG_VALUES = {
    # Always-defined 0/1 switches (AC_DEFINE_UNQUOTED): code tests them with
    # plain `if (X)` or `#if X`, so they must be defined even when 0.
    "ENABLE_EXTRA_CHECKING": "0",
    "GATHER_STATISTICS": "0",
    "ENABLE_FIXED_POINT": "0",
    "ENABLE_VTABLE_VERIFY": "0",
    # Upstream default (no --disable-analyzer); see note 4c-1.
    "ENABLE_ANALYZER": "1",
    "ENABLE_OFFLOADING": "0",
    "DEFAULT_STK_CLASH_GUARD_SIZE": "0",
    "HAVE_GNU_AS": "1",
    "HAVE_GNU_LD": "1",
    # musl: default_gnu_indirect_function unset (config.gcc:3586-3587);
    # targhooks.c:637 returns this value, so it must be defined.
    "HAVE_GNU_INDIRECT_FUNCTION": "0",
    "HAVE_INITFINI_ARRAY_SUPPORT": "1",
    "TARGET_GLIBC_MAJOR": "0",
    "TARGET_GLIBC_MINOR": "0",
    "HAVE_LTO_PLUGIN": "0",
    "DEFAULT_USE_CXA_ATEXIT": "2",
    "EXTRA_MODES_FILE": "\"config/i386/i386-modes.def\"",
    "DIAGNOSTICS_COLOR_DEFAULT": "DIAGNOSTICS_COLOR_AUTO",
    "DIAGNOSTICS_URLS_DEFAULT": "DIAGNOSTICS_URL_AUTO",
    "DOCUMENTATION_ROOT_URL": "\"https://gcc.gnu.org/onlinedocs/\"",
    "CHANGES_ROOT_URL": "\"https://gcc.gnu.org/\"",
    "OFFLOAD_TARGETS": "\"\"",
    "LTOPLUGINSONAME": "\"liblto_plugin.so\"",
    "PLUGIN_LD_SUFFIX": "\"ld\"",
    # Assembler 0/1 probes.
    "HAVE_AS_LEB128": "1",
    "HAVE_GAS_CFI_DIRECTIVE": "1",
    "HAVE_GAS_CFI_PERSONALITY_DIRECTIVE": "1",
    "HAVE_GAS_CFI_SECTIONS_DIRECTIVE": "1",
    "HAVE_GAS_SECTION_EXCLUDE": "1",
    "HAVE_GAS_SHF_MERGE": "1",
    "HAVE_COMDAT_GROUP": "1",
    "HAVE_AS_IX86_INTERUNIT_MOVQ": "1",
    # 32-bit-only probes. The x86_64-only binutils cannot assemble or link
    # them, and every consumer is behind !TARGET_64BIT.
    "HAVE_AS_GOTOFF_IN_DATA": "0",
    "HAVE_AS_IX86_TLSLDMPLT": "0",
    "HAVE_AS_IX86_TLSLDM": "0",
    "HAVE_AS_IX86_GOT32X": "0",
    "HAVE_AS_IX86_TLS_GET_ADDR_GOT": "0",
    # cellar gas links the bundled zlib; see note 4c-4.
    "HAVE_AS_COMPRESS_DEBUG": "2",
    "AS_COMPRESS_DEBUG_OPTION": "\"--compress-debug-sections\"",
    "AS_NO_COMPRESS_DEBUG_OPTION": "\"--nocompress-debug-sections\"",
    # Linker probes.
    "HAVE_LD_ALIGNED_SHF_MERGE": "1",
    "HAVE_LD_EH_FRAME_CIEV3": "1",
    "HAVE_LD_PIE_COPYRELOC": "1",
    "HAVE_LD_COMPRESS_DEBUG": "3",
    "LD_COMPRESS_DEBUG_OPTION": "\"--compress-debug-sections\"",
    "LD_STATIC_OPTION": "\"-Bstatic\"",
    "LD_DYNAMIC_OPTION": "\"-Bdynamic\"",
    "LD_AS_NEEDED_OPTION": "\"--push-state --as-needed\"",
    "LD_NO_AS_NEEDED_OPTION": "\"--pop-state\"",
    # Host C library declarations not covered by library-config.h.
    "HAVE_DECL_ATOF": "1",
    "HAVE_DECL_ATOL": "1",
    "HAVE_DECL_ATOLL": "1",
    "HAVE_DECL_CLOCK": "1",
    "HAVE_DECL_FREE": "1",
    "HAVE_DECL_GETCWD": "1",
    "HAVE_DECL_GETPAGESIZE": "1",
    "HAVE_DECL_GETRLIMIT": "1",
    "HAVE_DECL_SETRLIMIT": "1",
    "HAVE_DECL_GETRUSAGE": "1",
    "HAVE_DECL_MADVISE": "1",
    "HAVE_DECL_SETENV": "1",
    "HAVE_DECL_UNSETENV": "1",
    "HAVE_DECL_SIGALTSTACK": "1",
    "HAVE_DECL_STPCPY": "1",
    "HAVE_DECL_STRSIGNAL": "1",
    "HAVE_DECL_STRSTR": "1",
    "HAVE_DECL_TIMES": "1",
    # musl has no getwd, mallinfo or ldgetname. system.h:483 then declares getwd.
    "HAVE_DECL_GETWD": "0",
    "HAVE_DECL_MALLINFO": "0",
    "HAVE_DECL_LDGETNAME": "0",
}

# config.in leaves these visible to target libraries (USED_FOR_TARGET).
GCC_TARGET_CONFIG = [
    "ENABLE_RUNTIME_CHECKING",
    "HAVE_GAS_CFI_DIRECTIVE",
    "HAVE_GAS_CFI_PERSONALITY_DIRECTIVE",
    "HAVE_GAS_CFI_SECTIONS_DIRECTIVE",
    "HAVE_GAS_HIDDEN",
    "HAVE_LD_EH_FRAME_HDR",
    "TARGET_DL_ITERATE_PHDR",
]

write_file(
    name = "auto-host.h",
    content = "".join(["#define " + name + " 1\n" for name in GCC_TARGET_CONFIG]) + '#ifndef USED_FOR_TARGET\n#include "library-config.h"\n' + "".join(["#define " + name + " 1\n" for name in GCC_CONFIG_ON if name not in GCC_TARGET_CONFIG]) + "".join(["#define " + name + " " + value + "\n" for name, value in GCC_CONFIG_VALUES.items() if name not in GCC_TARGET_CONFIG]) + "#endif\n",
)

# gcc/mkconfig.sh output for config.gcc's x86_64-*-linux*musl* target files.
TM_DEFINES = [
    ("LIBC_GLIBC", "1"),
    ("LIBC_UCLIBC", "2"),
    ("LIBC_BIONIC", "3"),
    ("LIBC_MUSL", "4"),
    ("DEFAULT_LIBC", "LIBC_MUSL"),
    ("ANDROID_DEFAULT", "0"),
]

TM_FILES = [
    "vxworks-dummy.h",
    "i386/biarch64.h",
    "i386/i386.h",
    "i386/unix.h",
    "i386/att.h",
    "dbxelf.h",
    "elfos.h",
    "gnu-user.h",
    "glibc-stdint.h",
    "i386/x86-64.h",
    "i386/gnu-user-common.h",
    "i386/gnu-user64.h",
    "linux.h",
    "linux-android.h",
    "i386/linux-common.h",
    "i386/linux64.h",
    "initfini-array.h",
]

write_file(
    name = "tm.h",
    content = mkconfig(
        "GCC_TM_H",
        [
            "options.h",
            "insn-constants.h",
        ] + ["config/" + name for name in TM_FILES],
        after = '#if defined IN_GCC && !defined GENERATOR_FILE && !defined USED_FOR_TARGET\n# include "insn-flags.h"\n#endif\n#if defined IN_GCC && !defined GENERATOR_FILE\n# include "insn-modes.h"\n#endif\n# include "defaults.h"\n' +
                # musl has no split-stack slot in its thread control block.
                "#undef TARGET_CAN_SPLIT_STACK\n#undef TARGET_THREAD_SPLIT_STACK_OFFSET\n",
        defines = TM_DEFINES,
    ),
)

write_file(
    name = "tm_p.h",
    content = mkconfig(
        "GCC_TM_P_H",
        [
            "config/i386/i386-protos.h",
            "config/linux-protos.h",
            "tm-preds.h",
        ],
    ),
)

[
    write_file(
        name = name,
        content = mkconfig(
            guard,
            ["ansidecl.h"],
            defines = defines,
            header = "auto-host.h",
        ),
    )
    for name, guard, defines in [
        ("config.h", "GCC_CONFIG_H", []),
        ("bconfig.h", "GCC_BCONFIG_H", []),
        (
            "tconfig.h",
            "GCC_TCONFIG_H",
            [("USED_FOR_TARGET", "")],
        ),
    ]
]

# The generated header's comment names the generator, not its action path,
# as in the GCC 4.7 port.
exact_patch(
    name = "gcov-iov.c",
    src = ":gcc-10.5.0[gcc/gcov-iov.c]",
    output = "gcov-iov.c",
    patch = GCC47 + ":patches/gcov-program.patch",
)

# genmatch resolves match.pd's include of the generated cfn-operators.pd from
# its working directory. Name that directory "." rather than its absolute
# action path, which would otherwise be recorded in the generated sources.
exact_patch(
    name = "genmatch.c",
    src = ":gcc-10.5.0[gcc/genmatch.c]",
    after = "  dir->name = ASTRDUP (\".\");\n  cpp_set_include_chains",
    before = "  dir->name = getpwd ();\n  if (!dir->name)\n    dir->name = ASTRDUP (\".\");\n  cpp_set_include_chains",
    output = "genmatch.c",
)

# cp/except.c recognizes nonthrowing C library calls through gperf's cfns.h.
# The bootstrapped awk writes an equivalent table lookup from cfns.gperf.
export_file(name = "generators/gperf.awk")

generate(
    name = "cfns.h",
    args = [
        "-v",
        "lookup=libc_name_p",
        "-f",
        "$(location :generators/gperf.awk)",
        "$(location :gcc-10.5.0[gcc/cp/cfns.gperf])",
    ],
    capture = CAPTURE,
    output = "cfns.h",
    tool = "cellar//bootstrap/stage1/gawk-final:gawk",
)

# The names in gperf's shipped word list, which the test looks up in both
# tables.
generate(
    name = "cfns-shipped-names.h",
    args = [
        "-n",
        "-e",
        's/^ *{\\("[^"]*"\\),.*$/\\1,/p',
        "$(location :gcc-10.5.0[gcc/cp/cfns.h])",
    ],
    capture = CAPTURE,
    tool = SED,
)

filegroup(
    name = "cfns-names",
    srcs = {"shipped-names.h": ":cfns-shipped-names.h"},
)

[
    filegroup(
        name = "cfns-" + kind,
        srcs = {"cfns.h": header},
    )
    for kind, header in [
        ("generated", ":cfns.h"),
        ("shipped", ":gcc-10.5.0[gcc/cp/cfns.h]"),
    ]
]

[
    c_object(
        name = "cfns-" + kind + ".o",
        src = "tests/cfns-lookup.cc",
        defines = [
            "CFNS_NAMESPACE=" + kind,
            "CFNS_LOOKUP=" + kind + "_lookup",
        ] + (["CFNS_TABLE=1"] if kind == "generated" else []),
        flags = [
            "-O2",
            "-Werror",
        ],
        headers = [":cfns-" + kind],
        includes = [":cfns-" + kind],
        toolchain = HOST_CXX["stage1"],
    )
    for kind in [
        "generated",
        "shipped",
    ]
]

c_object(
    name = "cfns-main.o",
    src = "tests/cfns-main.cc",
    flags = [
        "-O2",
        "-Werror",
    ],
    headers = [":cfns-names"],
    includes = [":cfns-names"],
    toolchain = HOST_CXX["stage1"],
)

c_binary(
    name = "cfns-test-bin",
    end_objects = HOST_CRTN["stage1"],
    libraries = HOST_LIBCXX["stage1"],
    objects = HOST_CRT["stage1"] + [
        ":cfns-main.o",
        ":cfns-generated.o",
        ":cfns-shipped.o",
    ],
    toolchain = HOST_CC["stage1"],
)

command_test(
    name = "cfns-lookup",
    tool = ":cfns-test-bin",
)

# Numbered pass instances, including the x86 passes from i386/t-i386.
generate(
    name = "pass-instances.def",
    args = [
        "-f",
        "$(location :gcc-10.5.0[gcc/gen-pass-instances.awk])",
        "$(location :gcc-10.5.0[gcc/passes.def])",
        "$(location :gcc-10.5.0[gcc/config/i386/i386-passes.def])",
    ],
    capture = CAPTURE,
    output = "pass-instances.def",
    tool = "cellar//bootstrap/stage1/gawk-final:gawk",
)

generate(
    name = "i386-builtin-types.inc",
    args = [
        "-f",
        "$(location :gcc-10.5.0[gcc/config/i386/i386-builtin-types.awk])",
        "$(location :gcc-10.5.0[gcc/config/i386/i386-builtin-types.def])",
    ],
    capture = CAPTURE,
    output = "i386-builtin-types.inc",
    tool = "cellar//bootstrap/stage1/gawk-final:gawk",
)

# The C, C++ and LTO option records, as in the GCC 4.7 port. configure also
# gathers every other front end's lang.opt; those front ends are not built.
OPTION_FILES = [
    "gcc/lto/lang.opt",
    "gcc/c-family/c.opt",
    "gcc/common.opt",
    "gcc/params.opt",
    "gcc/analyzer/analyzer.opt",
    "gcc/config/fused-madd.opt",
    "gcc/config/i386/i386.opt",
    "gcc/config/gnu-user.opt",
    "gcc/config/linux.opt",
    "gcc/config/linux-android.opt",
]

# opt-gather.awk compares records as strings; LC_ALL=C fixes their order.
generate(
    name = "optionlist",
    args = [
        "-f",
        "$(location :gcc-10.5.0[gcc/opt-gather.awk])",
    ] + ["$(location :gcc-10.5.0[" + path + "])" for path in OPTION_FILES],
    capture = CAPTURE,
    env = {"LC_ALL": "C"},
    tool = "cellar//bootstrap/stage1/gawk-final:gawk",
)

OPTION_GENERATORS = [
    ("options.h", "opth-gen.awk", ""),
    ("options.c", "optc-gen.awk", "config.h system.h coretypes.h options.h tm.h"),
    ("options-save.c", "optc-save-gen.awk", "config.h system.h coretypes.h tm.h"),
]

[
    generate(
        name = output,
        args = [
            "-f",
            "$(location :gcc-10.5.0[gcc/opt-functions.awk])",
            "-f",
            "$(location :gcc-10.5.0[gcc/opt-read.awk])",
            "-f",
            "$(location :gcc-10.5.0[gcc/" + script + "])",
        ] + ([
            "-v",
            "header_name=" + headers,
        ] if headers else []),
        capture = CAPTURE,
        output = output,
        stdin = ":optionlist",
        tool = "cellar//bootstrap/stage1/gawk-final:gawk",
    )
    for output, script, headers in OPTION_GENERATORS
]

write_file(
    name = "all-tree.def",
    content = '#include "tree.def"\nEND_OF_BASE_TREE_CODES\n#include "c-family/c-common.def"\n#include "cp/cp-tree.def"\n',
)

write_file(
    name = "bversion.h",
    content = "#define BUILDING_GCC_MAJOR 10\n#define BUILDING_GCC_MINOR 5\n#define BUILDING_GCC_PATCHLEVEL 0\n#define BUILDING_GCC_VERSION (BUILDING_GCC_MAJOR * 1000 + BUILDING_GCC_MINOR)\n",
)

# Configuration shared by every generator and compiler stage.
CONFIG_OVERLAY = {"build/gcc/" + name: ":" + name for name in [
    "library-config.h",
    "auto-host.h",
    "config.h",
    "bconfig.h",
    "tconfig.h",
    "tm.h",
    "tm_p.h",
    "all-tree.def",
    "bversion.h",
    "options.h",
    "options.c",
    "options-save.c",
    "pass-instances.def",
    "i386-builtin-types.inc",
]}

GCC_TREE = {path: ":gcc-10.5.0[" + path + "]" for path in GCC_FILES + LIBCPP_FILES} | {
    "include": ":gcc-10.5.0[include]",
    "gcc/gengtype-lex.c": ":gengtype-lex.c",
    "gcc/genmatch.c": ":genmatch.c",
    "gcc/cp/cfns.h": ":cfns.h",
    "gcc/gcov-iov.c": ":gcov-iov.c",
} | CONFIG_OVERLAY

GENERATOR_DEFINES = [
    "_GNU_SOURCE=1",
    "IN_GCC=1",
    "GENERATOR_FILE=1",
]

GENERATOR_INCLUDES = [
    "build/gcc",
    "gcc",
    "include",
    "libcpp/include",
]

# A release has no date or revision in its version string.
VERSION_DEFINES = [
    'BASEVER="10.5.0"',
    'DATESTAMP=""',
    'DEVPHASE=""',
    'REVISION=""',
    'PKGVERSION="(Cellar bootstrap) "',
    'BUGURL="<https://gcc.gnu.org/bugs/>"',
]

# Generator outputs, by the layer that first provides them. Each layer's tree
# holds everything earlier layers generated, in gcc's objdir under build/gcc.
MODE_OUTPUTS = [
    ("insn-modes.c", "genmodes", []),
    (
        "insn-modes.h",
        "genmodes",
        ["-h"],
    ),
    (
        "insn-modes-inline.h",
        "genmodes",
        ["-i"],
    ),
    (
        "min-insn-modes.c",
        "genmodes",
        ["-m"],
    ),
    ("genrtl.h", "gengenrtl", []),
]

CONSTANT_OUTPUTS = [
    ("insn-constants.h", "genconstants", []),
    ("insn-enums.c", "genenums", []),
]

PREDICATE_OUTPUTS = [
    ("insn-preds.c", "genpreds", []),
    (
        "tm-preds.h",
        "genpreds",
        ["-h"],
    ),
    (
        "tm-constrs.h",
        "genpreds",
        ["-c"],
    ),
    ("gencondmd.c", "genconditions", []),
]

# Read with insn-conditions.md.
MD_OUTPUTS = [
    ("insn-attr.h", "genattr"),
    ("insn-attr-common.h", "genattr-common"),
    ("insn-codes.h", "gencodes"),
    ("insn-config.h", "genconfig"),
    ("insn-flags.h", "genflags"),
    ("insn-target-def.h", "gentarget-def"),
    ("insn-automata.c", "genautomata"),
    ("insn-emit.c", "genemit"),
    ("insn-extract.c", "genextract"),
    ("insn-output.c", "genoutput"),
    ("insn-peep.c", "genpeep"),
    ("insn-recog.c", "genrecog"),
]

HOOK_OUTPUTS = [
    ("tree-check.h", "gencheck", []),
    (
        "target-hooks-def.h",
        "genhooks",
        ["Target Hook"],
    ),
    (
        "c-family/c-target-hooks-def.h",
        "genhooks",
        ["C Target Hook"],
    ),
    (
        "common/common-target-hooks-def.h",
        "genhooks",
        ["Common Target Hook"],
    ),
    (
        "case-cfn-macros.h",
        "gencfn-macros",
        ["-c"],
    ),
    (
        "cfn-operators.pd",
        "gencfn-macros",
        ["-o"],
    ),
]

# Generator layers: each tree adds the previous layers' outputs, named by
# their targets without the stage prefix.
GENERATED_LAYERS = [
    {output: output.replace("/", "-") for output, tool, args in MODE_OUTPUTS},
    {output: output.replace("/", "-") for output, tool, args in CONSTANT_OUTPUTS} |
    {output: "gtype-output[" + output + "]" for output in GTYPE_OUTPUTS},
    {output: output.replace("/", "-") for output, tool, args in PREDICATE_OUTPUTS},
    {output: output.replace("/", "-") for output, tool, args in HOOK_OUTPUTS} | {
        "insn-conditions.md": "insn-conditions.md",
    },
]

[
    filegroup(
        name = stage + "-generator-tree" + str(layer),
        srcs = GCC_TREE | {
            "build/gcc/" + output: ":" + stage + "-" + target
            for outputs in GENERATED_LAYERS[:layer]
            for output, target in outputs.items()
        },
    )
    for stage in STAGES
    for layer in range(len(GENERATED_LAYERS) + 1)
]

# Build objects and the first tree that can compile each one.
BUILD_RTL = [
    "rtl",
    "read-rtl",
    "ggc-none",
    "vec",
    "min-insn-modes",
    "gensupport",
    "print-rtl",
    "hash-table",
    "sort",
]

GENERATOR_OBJECTS = {
    "errors": 0,
    "genmodes": 0,
    "gengenrtl": 0,
    "min-insn-modes": 1,
    "read-md": 1,
    "genconstants": 1,
    "genenums": 1,
    "rtl": 2,
    "read-rtl": 2,
    "ggc-none": 2,
    "vec": 2,
    "gensupport": 2,
    "print-rtl": 2,
    "hash-table": 2,
    "sort": 2,
    "inchash": 2,
    "genpreds": 2,
    "genconditions": 2,
    "genattr": 2,
    "genattr-common": 2,
    "genattrtab": 2,
    "genautomata": 2,
    "gencodes": 2,
    "genconfig": 2,
    "genemit": 2,
    "genextract": 2,
    "genflags": 2,
    "genopinit": 2,
    "genoutput": 2,
    "genpeep": 2,
    "genrecog": 2,
    "gentarget-def": 2,
    "gencheck": 2,
    "genhooks": 2,
    "gencfn-macros": 2,
    "gengtype": 0,
    "gengtype-lex": 0,
    "gengtype-parse": 0,
    "gengtype-state": 0,
    "version": 0,
    "gcov-iov": 2,
    "genchecksum": 2,
    "gencondmd": 3,
    "genmatch": 4,
}

GENERATED_SOURCES = [
    "min-insn-modes",
    "gencondmd",
]

[
    c_object(
        name = stage + "-build-" + name + ".o",
        src = ":" + stage + "-generator-tree" + str(layer),
        defines = GENERATOR_DEFINES + (VERSION_DEFINES if name == "version" else []),
        flags = LANGUAGE_FLAGS["c++"] + [
            "-O2",
            "-Werror",
        ],
        logical_includes = GENERATOR_INCLUDES,
        logical_source = ("build/gcc/" if name in GENERATED_SOURCES else "gcc/") + name + (".cc" if name == "sort" else ".c"),
        object_name = name + ".o",
        source_alias = SOURCE_ALIAS,
        source_tree = ":" + stage + "-generator-tree" + str(layer),
        toolchain = HOST_CXX[stage],
    )
    for stage in STAGES
    for name, layer in GENERATOR_OBJECTS.items()
]

GENERATORS = {
    name: [name] + BUILD_RTL + [
        "read-md",
        "errors",
    ]
    for name in [
        "genattr",
        "genattr-common",
        "genattrtab",
        "genautomata",
        "gencodes",
        "genconditions",
        "genconfig",
        "genemit",
        "genextract",
        "genflags",
        "genopinit",
        "genoutput",
        "genpeep",
        "genpreds",
        "gentarget-def",
    ]
} | {
    "genrecog": ["genrecog"] + BUILD_RTL + [
        "read-md",
        "errors",
        "inchash",
    ],
    "genconstants": [
        "genconstants",
        "read-md",
        "errors",
    ],
    "genenums": [
        "genenums",
        "read-md",
        "errors",
    ],
    "gengenrtl": [
        "gengenrtl",
        "errors",
    ],
    "genmodes": [
        "genmodes",
        "errors",
    ],
    "genhooks": [
        "genhooks",
        "errors",
    ],
    "gencfn-macros": [
        "gencfn-macros",
        "errors",
        "hash-table",
        "vec",
        "ggc-none",
        "sort",
    ],
    "gencondmd": [
        "gencondmd",
        "errors",
    ],
    "gengtype": [
        "gengtype",
        "errors",
        "gengtype-lex",
        "gengtype-parse",
        "gengtype-state",
        "version",
    ],
    "gencheck": ["gencheck"],
    "genchecksum": ["genchecksum"],
    "genmatch": [
        "genmatch",
        "errors",
        "vec",
        "hash-table",
        "sort",
    ],
    "gcov-iov": ["gcov-iov"],
}

[
    c_binary(
        name = stage + "-" + name,
        end_objects = HOST_CRTN[stage],
        libraries = ([":" + stage + "-libcpp.a"] if name == "genmatch" else []) + [":" + stage + "-libiberty.a"] + HOST_LIBCXX[stage],
        objects = HOST_CRT[stage] + [":" + stage + "-build-" + obj + ".o" for obj in objects],
        toolchain = HOST_CC[stage],
    )
    for stage in STAGES
    for name, objects in GENERATORS.items()
]

MD_FILES = [
    "common.md",
    "config/i386/i386.md",
]

# Outputs written to standard output. Machine-description readers run in gcc/
# so the file names they record are the stable relative spellings.
[
    generate(
        name = stage + "-" + output.replace("/", "-"),
        args = args + (MD_FILES if tool.startswith("gen") and tool not in [
            "genmodes",
            "gengenrtl",
            "gencheck",
            "genhooks",
            "gencfn-macros",
        ] else []),
        capture = CAPTURE,
        output = output.replace("/", "-"),
        tool = ":" + stage + "-" + tool,
        working_directory = ":" + stage + "-generator-tree" + str(layer) + "[gcc]",
    )
    for stage in STAGES
    for layer, outputs in [
        (0, MODE_OUTPUTS),
        (1, CONSTANT_OUTPUTS),
        (2, PREDICATE_OUTPUTS),
        (2, HOOK_OUTPUTS),
    ]
    for output, tool, args in outputs
]

[
    generate(
        name = stage + "-insn-conditions.md",
        capture = CAPTURE,
        output = "insn-conditions.md",
        tool = ":" + stage + "-gencondmd",
    )
    for stage in STAGES
]

[
    generate(
        name = stage + "-" + output,
        args = MD_FILES + ["../build/gcc/insn-conditions.md"],
        capture = CAPTURE,
        # The conditions lie outside gcc/, so the whole tree is an input;
        # remote workers receive only the declared paths.
        inputs = [":" + stage + "-generator-tree4"],
        output = output,
        tool = ":" + stage + "-" + tool,
        working_directory = ":" + stage + "-generator-tree4[gcc]",
    )
    for stage in STAGES
    for output, tool in MD_OUTPUTS
]

# genattrtab and genopinit write several named files.
[
    generate(
        name = stage + "-" + tool + "-outputs",
        args = ["source/gcc/" + path for path in MD_FILES] + [
            "source/build/gcc/insn-conditions.md",
        ] + args,
        chdir = "cellar//bootstrap/stage0-posix/cellar-extra:chdirenv",
        directory = True,
        files = files,
        source_alias = SOURCE_ALIAS,
        source_tree = ":" + stage + "-generator-tree4",
        tool = ":" + stage + "-" + tool,
    )
    for stage in STAGES
    for tool, args, files in [
        (
            "genattrtab",
            [
                "-Ainsn-attrtab.c",
                "-Dinsn-dfatab.c",
                "-Linsn-latencytab.c",
            ],
            [
                "insn-attrtab.c",
                "insn-dfatab.c",
                "insn-latencytab.c",
            ],
        ),
        (
            "genopinit",
            [
                "-hinsn-opinit.h",
                "-cinsn-opinit.c",
            ],
            [
                "insn-opinit.h",
                "insn-opinit.c",
            ],
        ),
    ]
]

# genmatch finds match.pd's generated cfn-operators.pd in its working
# directory, the objdir that holds it.
[
    generate(
        name = stage + "-" + kind + "-match.c",
        args = [
            "--" + kind,
            "../../gcc/match.pd",
        ],
        capture = CAPTURE,
        # match.pd lies outside build/gcc, so the whole tree is an input.
        inputs = [":" + stage + "-generator-tree4"],
        output = kind + "-match.c",
        tool = ":" + stage + "-genmatch",
        working_directory = ":" + stage + "-generator-tree4[build/gcc]",
    )
    for stage in STAGES
    for kind in [
        "gimple",
        "generic",
    ]
]

write_file(
    name = "gtyp-input.list",
    content = "\n".join([
        path if path.startswith("[") else "source/build/gcc/" + path if path in [
            "auto-host.h",
            "options.h",
        ] else "source/" + path
        for path in GTYPE_INPUTS
    ]) + "\n",
)

[
    generate(
        name = stage + "-gtype-state",
        args = [
            "-S",
            "source/gcc",
            "-I",
            "$(location :gtyp-input.list)",
            "-w",
            "gtype.state",
        ],
        chdir = "cellar//bootstrap/stage0-posix/cellar-extra:chdirenv",
        directory = True,
        files = ["gtype.state"],
        source_alias = SOURCE_ALIAS,
        source_tree = ":" + stage + "-generator-tree0",
        tool = ":" + stage + "-gengtype",
    )
    for stage in STAGES
]

[
    generate(
        name = stage + "-gtype-output",
        args = [
            "-r",
            "$(location :" + stage + "-gtype-state[gtype.state])",
        ],
        chdir = "cellar//bootstrap/stage0-posix/cellar-extra:chdirenv",
        directory = True,
        files = GTYPE_OUTPUTS,
        source_alias = SOURCE_ALIAS,
        source_tree = ":" + stage + "-generator-tree0",
        tool = ":" + stage + "-gengtype",
    )
    for stage in STAGES
]

[
    generate(
        name = stage + "-gcov-iov.h",
        args = [
            "10.5.0",
            "",
        ],
        capture = CAPTURE,
        output = "gcov-iov.h",
        tool = ":" + stage + "-gcov-iov",
    )
    for stage in STAGES
]

# The C and C++ compilers follow gcc/Makefile.in, c/Make-lang.in and
# cp/Make-lang.in.
TARGET = "x86_64-cellar-linux-musl"

GCC_PREFIX = "/nonexistent-bootstrap-gcc"

SYSROOT = "/nonexistent-bootstrap-sysroot"

write_file(
    name = "configargs.h",
    content = "static const char configuration_arguments[] = \"cellar Buck2 native " + TARGET + ", C/C++, static, no multilib/LTO/plugins/NLS/isl\";\nstatic const char thread_model[] = \"posix\";\nstatic const struct {\n  const char *name, *value;\n} configure_default_options[] = { { \"cpu\", \"generic\" }, { \"arch\", \"x86-64\" } };\n",
)

# One native x86_64 library directory, as in the GCC 4.7 port.
write_file(
    name = "multilib.h",
    content = "static const char *const multilib_raw[] = {\". ;\", 0};\nstatic const char *const multilib_reuse_raw[] = {0};\nstatic const char *const multilib_matches_raw[] = {0};\nstatic const char *multilib_extra = \"\";\nstatic const char *const multilib_exclusions_raw[] = {0};\nstatic const char *multilib_options = \"\";\n",
)

write_file(
    name = "specs.h",
    content = '#include "cp/lang-specs.h"\n',
)

write_file(
    name = "omp-device-properties.h",
    content = "const char omp_offload_device_kind[] = \n\"\";\nconst char omp_offload_device_arch[] = \n\"\";\nconst char omp_offload_device_isa[] = \n\"\";\n",
)

MD_TREE = {output: output for output, tool in MD_OUTPUTS} | {
    "insn-attrtab.c": "genattrtab-outputs[insn-attrtab.c]",
    "insn-dfatab.c": "genattrtab-outputs[insn-dfatab.c]",
    "insn-latencytab.c": "genattrtab-outputs[insn-latencytab.c]",
    "insn-opinit.h": "genopinit-outputs[insn-opinit.h]",
    "insn-opinit.c": "genopinit-outputs[insn-opinit.c]",
    "gimple-match.c": "gimple-match.c",
    "generic-match.c": "generic-match.c",
    "gcov-iov.h": "gcov-iov.h",
}

COMPILER_TREES = {stage: GCC_TREE | {
    "build/gcc/" + output: ":" + stage + "-" + target
    for outputs in GENERATED_LAYERS + [MD_TREE]
    for output, target in outputs.items()
} | {"build/gcc/" + name: ":" + name for name in [
    "configargs.h",
    "multilib.h",
    "specs.h",
    "omp-device-properties.h",
]} | {path: ":gcc-10.5.0[" + path + "]" for path in LIBDECNUMBER_FILES} | {
    "libdecnumber/config.h": ":library-config.h",
    "libdecnumber/gstdint.h": ":gstdint.h",
    "libdecnumber/decDPD.h": ":" + stage + "-decDPD.h",
    "libdecnumber/bid/bid2dpd_dpd2bid.h": ":" + stage + "-bid2dpd_dpd2bid.h",
    "libbacktrace/backtrace.h": ":gcc-10.5.0[libbacktrace/backtrace.h]",
    "build/libbacktrace/backtrace-supported.h": ":backtrace-supported.h",
    "gmp": "cellar//bootstrap/stage1/gmp:headers",
    "mpfr": "cellar//bootstrap/stage1/mpfr:headers",
    "mpc": "cellar//bootstrap/stage1/mpc:headers",
    "zlib": "cellar//bootstrap/stage1/binutils:zlib-source[zlib]",
} for stage in STAGES}

[
    filegroup(
        name = stage + "-compiler-tree",
        srcs = COMPILER_TREES[stage],
    )
    for stage in STAGES
]

COMPILER_DEFINES = [
    "_GNU_SOURCE=1",
    "IN_GCC=1",
    "HAVE_CONFIG_H=1",
]

BASEVER = 'BASEVER="10.5.0"'

PREPROCESSOR_DEFINES = [
    'GCC_INCLUDE_DIR="' + GCC_PREFIX + '/include"',
    'GPLUSPLUS_INCLUDE_DIR="/include/c++/10.5.0"',
    "GPLUSPLUS_INCLUDE_DIR_ADD_SYSROOT=1",
    'GPLUSPLUS_TOOL_INCLUDE_DIR="/include/c++/10.5.0/' + TARGET + '"',
    'GPLUSPLUS_BACKWARD_INCLUDE_DIR="/include/c++/10.5.0/backward"',
    'NATIVE_SYSTEM_HEADER_DIR="/include"',
    'PREFIX="' + GCC_PREFIX + '/"',
    'STANDARD_EXEC_PREFIX="' + GCC_PREFIX + '/lib/gcc/"',
    'TARGET_SYSTEM_ROOT="' + SYSROOT + '"',
]

DRIVER_DEFINES = [
    'STANDARD_STARTFILE_PREFIX="/lib/"',
    'STANDARD_STARTFILE_PREFIX_1=""',
    'STANDARD_STARTFILE_PREFIX_2=""',
    'STANDARD_EXEC_PREFIX="' + GCC_PREFIX + '/lib/gcc/"',
    'STANDARD_LIBEXEC_PREFIX="' + GCC_PREFIX + '/libexec/gcc/"',
    'STANDARD_BINDIR_PREFIX="' + GCC_PREFIX + '/bin/"',
    'DEFAULT_TARGET_VERSION="10.5.0"',
    'DEFAULT_REAL_TARGET_MACHINE="' + TARGET + '"',
    'DEFAULT_TARGET_MACHINE="' + TARGET + '"',
    'TOOLDIR_BASE_PREFIX="../../../"',
    'ACCEL_DIR_SUFFIX=""',
    'TARGET_SYSTEM_ROOT="' + SYSROOT + '"',
    'CONFIGURE_SPECS=""',
    'NATIVE_SYSTEM_HEADER_DIR="/include"',
]

# gcc/Makefile.in CFLAGS-<object> additions.
OBJECT_DEFINES = {
    "gcc": DRIVER_DEFINES + [BASEVER],
    "c/gccspec": DRIVER_DEFINES,
    "cp/g++spec": DRIVER_DEFINES,
    "version": VERSION_DEFINES,
    "prefix": [
        'PREFIX="' + GCC_PREFIX + '"',
        BASEVER,
    ],
    "cppbuiltin": PREPROCESSOR_DEFINES + [BASEVER],
    "cppdefault": PREPROCESSOR_DEFINES,
    "c-family/c-opts": ['TARGET_SYSTEM_ROOT="' + SYSROOT + '"'],
    "c-family/c-pch": [
        'HOST_MACHINE="' + TARGET + '"',
        'TARGET_MACHINE="' + TARGET + '"',
    ],
    "toplev": ['TARGET_NAME="' + TARGET + '"'],
    "optinfo-emit-json": ['TARGET_NAME="' + TARGET + '"'],
    "lto-streamer-in": ['TARGET_MACHINE="' + TARGET + '"'],
    "intl": ['LOCALEDIR="/nonexistent-bootstrap-locale"'],
}

COMPILER_INCLUDES = [
    "build/gcc",
    "gcc",
    "include",
    "libcpp/include",
    "libdecnumber",
    "libdecnumber/bid",
    "libbacktrace",
    "build/libbacktrace",
    "gmp",
    "mpfr",
    "mpc",
    "zlib",
]

# Each object is compiled once, including incpath, which cc1plus also links
# directly.
COMPILER_OBJECTS = {name: None for name in BACKEND_OBJECTS + COMMON_OBJECTS + COMMON_TARGET_OBJECTS + C_OBJECTS + CXX_OBJECTS + ["main"]}

FRONTEND_OBJECTS = {name: None for name in C_OBJECTS + CXX_OBJECTS}

[
    c_object(
        name = stage + "-cc-" + name.replace("/", "-") + ".o",
        src = ":" + stage + "-compiler-tree",
        defines = COMPILER_DEFINES + OBJECT_DEFINES.get(name, []) + (["IN_GCC_FRONTEND=1"] if name in FRONTEND_OBJECTS else []),
        # Upstream's first stage accepts the older host compiler's warnings.
        flags = LANGUAGE_FLAGS["c++"] + ["-O2"] + ([] if stage == "stage1" else ["-Werror"]),
        logical_includes = COMPILER_INCLUDES[:2] + (["gcc/" + name.rpartition("/")[0]] if "/" in name else []) + COMPILER_INCLUDES[2:],
        logical_source = ("build/gcc/" + name + ".c") if name in GENERATED_COMPILER_SOURCES else ("gcc/" + name + (".cc" if name in CC_SOURCES else ".c")),
        object_name = "cc" + str(i) + ".o",
        source_alias = SOURCE_ALIAS,
        source_tree = ":" + stage + "-compiler-tree",
        toolchain = HOST_CXX[stage],
    )
    for stage in STAGES
    for i, name in enumerate(COMPILER_OBJECTS)
]

[
    c_library(
        name = stage + "-" + library + ".a",
        objects = [":" + stage + "-cc-" + name.replace("/", "-") + ".o" for name in objects],
        output = library + ".a",
        toolchain = HOST_CC[stage],
    )
    for stage in STAGES
    for library, objects in [
        ("libbackend", BACKEND_OBJECTS),
        ("libcommon", COMMON_OBJECTS),
        ("libcommon-target", COMMON_TARGET_OBJECTS),
    ]
]

# Each stage recompiles the already regenerated binutils zlib.
ZLIB_OBJECTS = [
    "adler32",
    "compress",
    "crc32",
    "deflate",
    "gzclose",
    "gzlib",
    "gzread",
    "gzwrite",
    "infback",
    "inffast",
    "inflate",
    "inftrees",
    "trees",
    "uncompr",
    "zutil",
]

[
    c_object(
        name = stage + "-zlib-" + name + ".o",
        src = "cellar//bootstrap/stage1/binutils:zlib-source[zlib/" + name + ".c]",
        defines = [
            "_GNU_SOURCE=1",
            "HAVE_UNISTD_H=1",
        ],
        flags = [
            "-O2",
            "-Werror",
        ],
        logical_includes = ["zlib"],
        logical_source = "zlib/" + name + ".c",
        object_name = "z" + str(i) + ".o",
        source_alias = SOURCE_ALIAS,
        source_tree = "cellar//bootstrap/stage1/binutils:zlib-source",
        toolchain = HOST_CC[stage],
    )
    for stage in STAGES
    for i, name in enumerate(ZLIB_OBJECTS)
]

[c_library(
    name = stage + "-libz.a",
    objects = [":" + stage + "-zlib-" + name + ".o" for name in ZLIB_OBJECTS],
    output = "libz.a",
    toolchain = HOST_CC[stage],
) for stage in STAGES]

# c/Make-lang.in: $(BACKEND) $(LIBS) $(BACKENDLIBS).
COMPILER_LIBRARIES = {stage: [":" + stage + "-" + name + ".a" for name in [
    "libbackend",
    "libcommon-target",
    "libcommon",
    "libcpp",
    "libdecnumber",
    "libcommon",
    "libcpp",
    "libbacktrace",
    "libiberty",
    "libdecnumber",
]] + [
    "cellar//bootstrap/stage1/mpc:libmpc.a",
    "cellar//bootstrap/stage1/mpfr:libmpfr.a",
    "cellar//bootstrap/stage1/gmp:libgmp.a",
    ":" + stage + "-libz.a",
] for stage in STAGES}

write_file(
    name = "checksum-options",
    content = "cellar native static compiler link; -O2 -g0 -frandom-seed=bootstrap; C,C++; no multilib, LTO, plugins or Graphite\n",
)

[
    [
        generate(
            name = stage + "-" + frontend + "-checksum.c",
            args = ["$(location :" + stage + "-cc-" + name.replace("/", "-") + ".o)" for name in objects] + [
                "$(location :" + stage + "-cc-main.o)",
            ] + ["$(location " + library + ")" for library in COMPILER_LIBRARIES[stage]] + [
                "$(location :checksum-options)",
            ],
            capture = CAPTURE,
            output = frontend + "-checksum.c",
            tool = ":" + stage + "-genchecksum",
        ),
        filegroup(
            name = stage + "-" + frontend + "-checksum-source",
            srcs = COMPILER_TREES[stage] | {"build/gcc/" + frontend + "-checksum.c": ":" + stage + "-" + frontend + "-checksum.c"},
        ),
        c_object(
            name = stage + "-" + frontend + "-checksum.o",
            src = ":" + stage + "-" + frontend + "-checksum-source",
            defines = COMPILER_DEFINES + ["IN_GCC_FRONTEND=1"],
            flags = LANGUAGE_FLAGS["c++"] + ["-O2"] + ([] if stage == "stage1" else ["-Werror"]),
            logical_includes = COMPILER_INCLUDES,
            logical_source = "build/gcc/" + frontend + "-checksum.c",
            source_alias = SOURCE_ALIAS,
            source_tree = ":" + stage + "-" + frontend + "-checksum-source",
            toolchain = HOST_CXX[stage],
        ),
        c_binary(
            name = stage + "-" + frontend,
            end_objects = HOST_CRTN[stage],
            libraries = COMPILER_LIBRARIES[stage] + HOST_LIBCXX[stage],
            objects = HOST_CRT[stage] + [":" + stage + "-cc-" + name.replace("/", "-") + ".o" for name in objects] + [
                ":" + stage + "-" + frontend + "-checksum.o",
                ":" + stage + "-cc-main.o",
            ],
            output = frontend,
            toolchain = HOST_CC[stage],
        ),
    ]
    for stage in STAGES
    for frontend, objects in [
        ("cc1", C_OBJECTS),
        ("cc1plus", CXX_OBJECTS),
    ]
]

# A compiler, assembler or linker the driver cannot find beside itself is an
# error, rather than a program to search for on the host PATH.
exact_patch(
    name = "driver-tool.c",
    src = ":gcc-10.5.0[gcc/gcc.c]",
    after = "      string = find_a_file (&exec_prefixes, commands[0].prog, X_OK, false);\n      if (!string)\n\tfatal_error (input_location, \"declared compiler tool not found: %s\", commands[0].prog);\n      commands[0].argv[0] = string;",
    before = "      string = find_a_file (&exec_prefixes, commands[0].prog, X_OK, false);\n      if (string)\n\tcommands[0].argv[0] = string;",
    output = "gcc.c",
)

exact_patch(
    name = "gcc.c",
    src = ":driver-tool.c",
    after = "\tif (!string)\n\t  fatal_error (input_location, \"declared compiler tool not found: %s\", commands[n_commands].prog);\n\tcommands[n_commands].argv[0] = string;",
    before = "\tif (string)\n\t  commands[n_commands].argv[0] = string;",
    output = "gcc.c",
)

# Static native executables only: no dynamic linker, PIE, shared objects or
# 32-bit multilibs. There is no collect2, so the driver runs ld directly.
write_file(
    name = "driver-tm.h",
    content = '#include "../gcc/tm.h"\n#undef LINK_SPEC\n#define LINK_SPEC "-m elf_x86_64 -static %{m32|mx32:%eOnly native x86_64 is supported} %{shared|pie|static-pie:%eOnly static executables are supported}"\n#undef STARTFILE_SPEC\n#define STARTFILE_SPEC "crt1.o%s crti.o%s crtbeginT.o%s"\n#undef ENDFILE_SPEC\n#define ENDFILE_SPEC GNU_USER_TARGET_MATHFILE_SPEC " crtend.o%s crtn.o%s"\n#undef LIB_SPEC\n#define LIB_SPEC "-lc"\n#undef LINK_GCC_C_SEQUENCE_SPEC\n#define LINK_GCC_C_SEQUENCE_SPEC "--start-group %G %{!nolibc:%L} --end-group"\n#undef LINK_EH_SPEC\n#define LINK_EH_SPEC ""\n',
)

[
    filegroup(
        name = stage + "-driver-tree",
        srcs = COMPILER_TREES[stage] | {
            "gcc/gcc.c": ":gcc.c",
            "build/driver/tm.h": ":driver-tm.h",
        },
    )
    for stage in STAGES
]

DRIVER_OBJECTS = [
    "gcc",
    "gcc-main",
    "ggc-none",
    "c/gccspec",
    "cp/g++spec",
    "c-family/cppspec",
    "config/i386/driver-i386",
    "gcov",
    "gcov-dump",
    "json",
    "hash-table",
]

[
    c_object(
        name = stage + "-driver-" + name.replace("/", "-") + ".o",
        src = ":" + stage + "-driver-tree",
        defines = COMPILER_DEFINES + OBJECT_DEFINES.get(name, []) + (["IN_GCC_FRONTEND=1"] if name in [
            "c/gccspec",
            "cp/g++spec",
        ] else []),
        flags = LANGUAGE_FLAGS["c++"] + ["-O2"] + ([] if stage == "stage1" else ["-Werror"]),
        logical_includes = ["build/driver"] + COMPILER_INCLUDES[:2] + (["gcc/" + name.rpartition("/")[0]] if "/" in name else []) + COMPILER_INCLUDES[2:],
        logical_source = "gcc/" + name + (".cc" if name in CC_SOURCES else ".c"),
        object_name = "driver" + str(i) + ".o",
        source_alias = SOURCE_ALIAS,
        source_tree = ":" + stage + "-driver-tree",
        toolchain = HOST_CXX[stage],
    )
    for stage in STAGES
    for i, name in enumerate(DRIVER_OBJECTS)
]

DRIVER_LIBRARIES = [
    "libcommon-target",
    "libcommon",
    "libcpp",
    "libbacktrace",
    "libiberty",
    "libdecnumber",
]

[
    c_binary(
        name = stage + "-" + program,
        end_objects = HOST_CRTN[stage],
        libraries = [":" + stage + "-" + name + ".a" for name in DRIVER_LIBRARIES] + ([":" + stage + "-libz.a"] if program == "gcov" else []) + HOST_LIBCXX[stage],
        objects = HOST_CRT[stage] + [":" + stage + "-driver-" + name.replace("/", "-") + ".o" for name in objects],
        output = program,
        toolchain = HOST_CC[stage],
    )
    for stage in STAGES
    for program, objects in [
        (
            "xgcc",
            [
                "gcc",
                "gcc-main",
                "ggc-none",
                "c/gccspec",
                "config/i386/driver-i386",
            ],
        ),
        (
            "g++",
            [
                "gcc",
                "gcc-main",
                "ggc-none",
                "cp/g++spec",
                "config/i386/driver-i386",
            ],
        ),
        (
            "cpp",
            [
                "gcc",
                "gcc-main",
                "ggc-none",
                "c-family/cppspec",
                "config/i386/driver-i386",
            ],
        ),
        (
            "gcov",
            [
                "gcov",
                "json",
                "hash-table",
                "ggc-none",
            ],
        ),
        (
            "gcov-dump",
            [
                "gcov-dump",
                "hash-table",
                "ggc-none",
            ],
        ),
    ]
]

# The new compiler's private headers: gcc/Makefile.in USER_H, the x86
# extra_headers from config.gcc, the stdint wrapper and libgcc's unwind.h.
COMPILER_HEADERS = [
    "float.h",
    "iso646.h",
    "stdarg.h",
    "stdbool.h",
    "stddef.h",
    "varargs.h",
    "stdfix.h",
    "stdnoreturn.h",
    "stdalign.h",
    "stdatomic.h",
    "stdint-gcc.h",
]

INTRINSIC_HEADERS = [
    "cpuid.h",
    "mmintrin.h",
    "mm3dnow.h",
    "xmmintrin.h",
    "emmintrin.h",
    "pmmintrin.h",
    "tmmintrin.h",
    "ammintrin.h",
    "smmintrin.h",
    "nmmintrin.h",
    "bmmintrin.h",
    "fma4intrin.h",
    "wmmintrin.h",
    "immintrin.h",
    "x86intrin.h",
    "avxintrin.h",
    "xopintrin.h",
    "ia32intrin.h",
    "cross-stdarg.h",
    "lwpintrin.h",
    "popcntintrin.h",
    "lzcntintrin.h",
    "bmiintrin.h",
    "bmi2intrin.h",
    "tbmintrin.h",
    "avx2intrin.h",
    "avx512fintrin.h",
    "fmaintrin.h",
    "f16cintrin.h",
    "rtmintrin.h",
    "xtestintrin.h",
    "rdseedintrin.h",
    "prfchwintrin.h",
    "adxintrin.h",
    "fxsrintrin.h",
    "xsaveintrin.h",
    "xsaveoptintrin.h",
    "avx512cdintrin.h",
    "avx512erintrin.h",
    "avx512pfintrin.h",
    "shaintrin.h",
    "clflushoptintrin.h",
    "xsavecintrin.h",
    "xsavesintrin.h",
    "avx512dqintrin.h",
    "avx512bwintrin.h",
    "avx512vlintrin.h",
    "avx512vlbwintrin.h",
    "avx512vldqintrin.h",
    "avx512ifmaintrin.h",
    "avx512ifmavlintrin.h",
    "avx512vbmiintrin.h",
    "avx512vbmivlintrin.h",
    "avx5124fmapsintrin.h",
    "avx5124vnniwintrin.h",
    "avx512vpopcntdqintrin.h",
    "clwbintrin.h",
    "mwaitxintrin.h",
    "clzerointrin.h",
    "pkuintrin.h",
    "sgxintrin.h",
    "cetintrin.h",
    "gfniintrin.h",
    "cet.h",
    "avx512vbmi2intrin.h",
    "avx512vbmi2vlintrin.h",
    "avx512vnniintrin.h",
    "avx512vnnivlintrin.h",
    "vaesintrin.h",
    "vpclmulqdqintrin.h",
    "avx512vpopcntdqvlintrin.h",
    "avx512bitalgintrin.h",
    "pconfigintrin.h",
    "wbnoinvdintrin.h",
    "movdirintrin.h",
    "waitpkgintrin.h",
    "cldemoteintrin.h",
    "avx512bf16vlintrin.h",
    "avx512bf16intrin.h",
    "enqcmdintrin.h",
    "avx512vp2intersectintrin.h",
    "avx512vp2intersectvlintrin.h",
]

filegroup(
    name = "compiler-headers",
    srcs = {name: ":gcc-10.5.0[gcc/ginclude/" + name + "]" for name in COMPILER_HEADERS} |
           {name: ":gcc-10.5.0[gcc/config/i386/" + name + "]" for name in INTRINSIC_HEADERS} | {
        "stdint.h": ":gcc-10.5.0[gcc/ginclude/stdint-wrap.h]",
        "mm_malloc.h": ":gcc-10.5.0[gcc/config/i386/pmm_malloc.h]",
        "gcov.h": ":gcc-10.5.0[libgcc/gcov.h]",
        "unwind.h": ":gcc-10.5.0[libgcc/unwind-generic.h]",
    },
)

[
    filegroup(
        name = stage + "-native-tools",
        srcs = {
            "cc1": ":" + stage + "-cc1",
            "cc1plus": ":" + stage + "-cc1plus",
            "as": "cellar//bootstrap/stage1/binutils:as",
            "ld": "cellar//bootstrap/stage1/binutils:ld",
        },
    )
    for stage in STAGES
]

# The driver before its own runtime exists: musl's C library only. It builds
# the target runtime, so it cannot depend on it.
[
    [
        configured_tool(
            name = stage + "-bootstrap-driver",
            args = [
                "-B$(location :" + stage + "-native-tools)/",
                "-B$(location " + MUSL + ":runtime)/lib/",
                "-nostdinc",
                "-isystem",
                "$(location :compiler-headers)",
                "-isystem",
                "$(location " + MUSL + ":headers)",
            ],
            env = {"TMPDIR": "."},
            env_tool = "cellar//bootstrap/stage1/tools:withenv",
            tool = ":" + stage + "-xgcc",
        ),
        compiler(
            name = stage + "-bootstrap-gcc",
            abi = "x86_64-sysv",
            archive_flags = ["crsD"],
            archive_format = "ar",
            archiver = "cellar//bootstrap/stage1/binutils:ar",
            cflags = REPRODUCIBLE_FLAGS,
            compiler = ":" + stage + "-bootstrap-driver",
            execution_runtime = MUSL + ":runtime",
            family = "gcc",
            ldflags = ["-static"],
            linker = "cellar//bootstrap/stage1/binutils:ld",
            object_format = "elf64-x86-64",
            stage = "gcc-10.5.0-" + stage,
            sysroot = MUSL + ":runtime",
            target_compatible_with = [
                "cellar//bootstrap/platforms:linux",
                "cellar//bootstrap/platforms:amd64",
            ],
        ),
    ]
    for stage in STAGES
]

# GCC 10 enables the x86_64 signal-frame unwinder only for glibc. musl's
# __restore_rt is the same rt_sigreturn sequence, so enable it for musl too.
exact_patch(
    name = "linux-unwind.h",
    src = ":gcc-10.5.0[libgcc/config/i386/linux-unwind.h]",
    after = "#if !defined __GLIBC__ || !(__GLIBC__ == 2 && __GLIBC_MINOR__ == 0)",
    before = "#if defined __GLIBC__ && !(__GLIBC__ == 2 && __GLIBC_MINOR__ == 0)",
    output = "linux-unwind.h",
)

# libgcc/config.in for this target.
write_file(
    name = "auto-target.h",
    content = "\n".join(["#define " + name + " " + value for name, value in [
        ("AS_HIDDEN_DIRECTIVE", ".hidden"),
        ("HAVE_AS_AVX", "1"),
        ("HAVE_AS_CFI_SECTIONS", "1"),
        ("HAVE_CC_TLS", "1"),
        ("HAVE_FTW_H", "1"),
        ("HAVE_GETIPINFO", "1"),
        ("HAVE_INIT_PRIORITY", "1"),
        ("HAVE_INTTYPES_H", "1"),
        ("HAVE_MEMORY_H", "1"),
        ("HAVE_STDINT_H", "1"),
        ("HAVE_STDLIB_H", "1"),
        ("HAVE_STRINGS_H", "1"),
        ("HAVE_STRING_H", "1"),
        ("HAVE_SYS_AUXV_H", "1"),
        ("HAVE_SYS_STAT_H", "1"),
        ("HAVE_SYS_TYPES_H", "1"),
        ("HAVE_UNISTD_H", "1"),
        ("PACKAGE_BUGREPORT", '""'),
        ("PACKAGE_NAME", '"GNU C Runtime Library"'),
        ("PACKAGE_STRING", '"GNU C Runtime Library 1.0"'),
        ("PACKAGE_TARNAME", '"libgcc"'),
        ("PACKAGE_URL", '"http://www.gnu.org/software/libgcc/"'),
        ("PACKAGE_VERSION", '"1.0"'),
        ("SIZEOF_DOUBLE", "8"),
        ("SIZEOF_LONG_DOUBLE", "16"),
        ("STDC_HEADERS", "1"),
    ]]) + "\n",
)

# libgcc/mkheader.sh output.
write_file(
    name = "libgcc_tm.h",
    content = '#ifndef LIBGCC_TM_H\n#define LIBGCC_TM_H\n/* Automatically generated by mkheader.sh.  */\n#include "config/i386/elf-lib.h"\n#include "config/i386/value-unwind.h"\n#endif /* LIBGCC_TM_H */\n',
)

# The libgcc objdir: configuration headers and the links configure creates.
[
    filegroup(
        name = stage + "-runtime-tree",
        srcs = COMPILER_TREES[stage] | {
            "libgcc": ":gcc-10.5.0[libgcc]",
            "build/libgcc/auto-target.h": ":auto-target.h",
            "build/libgcc/libgcc_tm.h": ":libgcc_tm.h",
            "build/libgcc/md-unwind-support.h": ":linux-unwind.h",
            "build/libgcc/unwind.h": ":gcc-10.5.0[libgcc/unwind-generic.h]",
            "build/libgcc/sfp-machine.h": ":gcc-10.5.0[libgcc/config/i386/sfp-machine.h]",
            "build/libgcc/gthr-default.h": ":gcc-10.5.0[libgcc/gthr-posix.h]",
            "build/libgcc/enable-execute-stack.c": ":gcc-10.5.0[libgcc/enable-execute-stack-empty.c]",
        },
    )
    for stage in STAGES
]

RUNTIME_DEFINES = [
    "IN_GCC=1",
    "IN_LIBGCC2=1",
    "USE_ELF_SYMVER=1",
    "GTHREAD_USE_WEAK=0",
    "HAVE_CC_TLS=1",
    "USE_TLS=1",
    "ENABLE_DECIMAL_BID_FORMAT=1",
]

RUNTIME_FLAGS = [
    "-O2",
    "-fpic",
    "-mlong-double-80",
    "-fbuilding-libgcc",
    "-fno-stack-protector",
    "-Werror",
]

RUNTIME_INCLUDES = [
    "build/libgcc",
    "libgcc",
    "build/gcc",
    "gcc",
    "include",
    "libgcc/config/libbid",
]

[
    c_object(
        name = stage + "-libgcc-" + name + ".o",
        src = ":" + stage + "-runtime-tree",
        defines = RUNTIME_DEFINES + defines,
        flags = RUNTIME_FLAGS + flags,
        logical_includes = RUNTIME_INCLUDES[:2] + [source.rpartition("/")[0]] + RUNTIME_INCLUDES[2:],
        logical_source = "build/libgcc/enable-execute-stack.c" if name == "enable-execute-stack" else source,
        object_name = "lg" + str(i) + ".o",
        source_alias = SOURCE_ALIAS,
        source_tree = ":" + stage + "-runtime-tree",
        toolchain = ":" + stage + "-bootstrap-gcc",
    )
    for stage in STAGES
    for i, (name, source, defines, flags) in enumerate(LIBGCC_OBJECTS)
]

[
    c_library(
        name = stage + "-libgcc.a",
        objects = [":" + stage + "-libgcc-" + name + ".o" for name, source, defines, flags in LIBGCC_OBJECTS],
        output = "libgcc.a",
        toolchain = ":" + stage + "-bootstrap-gcc",
    )
    for stage in STAGES
]

[
    c_object(
        name = stage + "-libgcov-" + name + ".o",
        src = ":" + stage + "-runtime-tree",
        defines = RUNTIME_DEFINES + [define],
        flags = RUNTIME_FLAGS,
        logical_includes = RUNTIME_INCLUDES,
        logical_source = source,
        object_name = "cov" + str(i) + ".o",
        source_alias = SOURCE_ALIAS,
        source_tree = ":" + stage + "-runtime-tree",
        toolchain = ":" + stage + "-bootstrap-gcc",
    )
    for stage in STAGES
    for i, (name, source, define) in enumerate(LIBGCOV_OBJECTS)
]

[
    c_library(
        name = stage + "-libgcov.a",
        objects = [":" + stage + "-libgcov-" + name + ".o" for name, source, define in LIBGCOV_OBJECTS],
        output = "libgcov.a",
        toolchain = ":" + stage + "-bootstrap-gcc",
    )
    for stage in STAGES
]

# crtstuff.c defines IN_LIBGCC2 itself and takes libgcc/Makefile.in's
# CRTSTUFF_CFLAGS plus i386/t-crtstuff, without the libgcc2 flags.
[
    c_object(
        name = stage + "-" + name,
        src = ":" + stage + "-runtime-tree",
        defines = ["IN_GCC=1"] + defines,
        flags = [
            "-O2",
            "-g0",
            "-finhibit-size-directive",
            "-fno-inline",
            "-fno-exceptions",
            "-fno-zero-initialized-in-bss",
            "-fno-toplevel-reorder",
            "-fno-tree-vectorize",
            "-fbuilding-libgcc",
            "-fno-stack-protector",
            "-fno-omit-frame-pointer",
            "-fno-asynchronous-unwind-tables",
            "-Werror",
        ],
        logical_includes = RUNTIME_INCLUDES,
        logical_source = "libgcc/crtstuff.c",
        object_name = name,
        source_alias = SOURCE_ALIAS,
        source_tree = ":" + stage + "-runtime-tree",
        toolchain = ":" + stage + "-bootstrap-gcc",
    )
    for stage in STAGES
    for name, defines in [
        (
            "crtbeginT.o",
            [
                "CRT_BEGIN",
                "CRTSTUFFT_O",
            ],
        ),
        (
            "crtend.o",
            ["CRT_END"],
        ),
    ]
]

[
    c_object(
        name = stage + "-" + name,
        src = ":" + stage + "-runtime-tree",
        defines = RUNTIME_DEFINES + defines,
        flags = RUNTIME_FLAGS,
        logical_includes = RUNTIME_INCLUDES,
        logical_source = "libgcc/config/i386/" + source,
        object_name = name,
        source_alias = SOURCE_ALIAS,
        source_tree = ":" + stage + "-runtime-tree",
        toolchain = ":" + stage + "-bootstrap-gcc",
    )
    for stage in STAGES
    for name, source, defines in [
        (
            "crtprec32.o",
            "crtprec.c",
            ["__PREC=32"],
        ),
        (
            "crtprec64.o",
            "crtprec.c",
            ["__PREC=64"],
        ),
        (
            "crtprec80.o",
            "crtprec.c",
            ["__PREC=80"],
        ),
        (
            "crtfastmath.o",
            "crtfastmath.c",
            [],
        ),
    ]
]

[
    sysroot(
        name = stage + "-runtime",
        abi = "x86_64-sysv",
        files = {"include": MUSL + ":headers"},
        libraries = {
                        "lib/libc.a": MUSL + ":libc.a",
                        "lib/libgcc.a": ":" + stage + "-libgcc.a",
                        "lib/libgcov.a": ":" + stage + "-libgcov.a",
                    } |
                    {"lib/lib" + name + ".a": MUSL + ":lib" + name + ".a" for name in [
                        "m",
                        "pthread",
                        "dl",
                        "rt",
                        "util",
                        "resolv",
                        "xnet",
                    ]},
        object_format = "elf64-x86-64",
        objects = {"lib/" + name: MUSL + ":" + name for name in [
                      "crt1.o",
                      "crti.o",
                      "crtn.o",
                  ]} |
                  {"lib/" + name: ":" + stage + "-" + name for name in [
                      "crtbeginT.o",
                      "crtend.o",
                      "crtprec32.o",
                      "crtprec64.o",
                      "crtprec80.o",
                      "crtfastmath.o",
                  ]},
    )
    for stage in STAGES
]

[
    [
        configured_tool(
            name = stage + "-gcc-command",
            args = [
                "-B$(location :" + stage + "-native-tools)/",
                "-B$(location :" + stage + "-runtime)/lib/",
                "-nostdinc",
                "-isystem",
                "$(location :compiler-headers)",
                "-isystem",
                "$(location :" + stage + "-runtime[include])",
            ],
            env = {"TMPDIR": "."},
            env_tool = "cellar//bootstrap/stage1/tools:withenv",
            tool = ":" + stage + "-xgcc",
        ),
        compiler(
            name = stage + "-gcc",
            abi = "x86_64-sysv",
            archive_flags = ["crsD"],
            archive_format = "ar",
            archiver = "cellar//bootstrap/stage1/binutils:ar",
            cflags = REPRODUCIBLE_FLAGS,
            compiler = ":" + stage + "-gcc-command",
            execution_runtime = MUSL + ":runtime",
            family = "gcc",
            ldflags = ["-static"],
            linker = "cellar//bootstrap/stage1/binutils:ld",
            object_format = "elf64-x86-64",
            stage = "gcc-10.5.0-" + stage + "-native-runtime",
            sysroot = ":" + stage + "-runtime",
            target_compatible_with = [
                "cellar//bootstrap/platforms:linux",
                "cellar//bootstrap/platforms:amd64",
            ],
        ),
    ]
    for stage in STAGES
]

# Front ends, driver and runtime acceptance for the first GCC 10 stage.
write_file(
    name = "invalid.c",
    content = "int main(void) { return undeclared; }\n",
)

write_file(
    name = "invalid.cc",
    content = "template<class T> struct A { typedef typename T::missing type; }; A<int>::type value;\n",
)

write_file(
    name = "tiny.c",
    content = "int main(void) { return 0; }\n",
)

[
    command_test(
        name = "frontend-" + frontend + "-diagnostic",
        args = [
            "1",
            "$(exe :stage1-" + frontend + ")",
            "-quiet",
            "-frandom-seed=bootstrap",
            "-nostdinc",
            "$(location :" + source + ")",
            "-o",
            "/dev/null",
        ],
        tool = EXPECT_EXIT,
    )
    for frontend, source in [
        ("cc1", "invalid.c"),
        ("cc1plus", "invalid.cc"),
    ]
]

command_test(
    name = "frontend-missing-header",
    args = [
        "1",
        "$(exe :stage1-cc1)",
        "-quiet",
        "-frandom-seed=bootstrap",
        "-nostdinc",
        "$(location cellar//bootstrap/stage1/gcc40:tests/c-language.c)",
        "-o",
        "/dev/null",
    ],
    tool = EXPECT_EXIT,
)

filegroup(
    name = "no-assembler",
    srcs = {"cc1": ":stage1-cc1"},
)

command_test(
    name = "driver-missing-assembler",
    args = [
        "1",
        "$(exe :stage1-xgcc)",
        "-B$(location :no-assembler)/",
        "-pipe",
        "-frandom-seed=bootstrap",
        "-c",
        "$(location :tiny.c)",
        "-o",
        "/dev/null",
    ],
    env = {
        "PATH": "/usr/bin:/bin",
        "TMPDIR": ".",
    },
    host_paths = True,
    tool = EXPECT_EXIT,
)

command_test(
    name = "driver-missing-cc1",
    args = [
        "1",
        "$(exe :stage1-xgcc)",
        "-fsyntax-only",
        "$(location :tiny.c)",
    ],
    env = {"PATH": "/usr/bin:/bin"},
    host_paths = True,
    tool = EXPECT_EXIT,
)

# A release names no date in its version.
generate(
    name = "version-output.txt",
    args = ["--version"],
    capture = CAPTURE,
    tool = ":stage1-xgcc",
)

generate(
    name = "version-line.txt",
    args = [
        "1!d",
        "$(location :version-output.txt)",
    ],
    capture = CAPTURE,
    tool = SED,
)

write_file(
    name = "version-expected.txt",
    content = "xgcc (Cellar bootstrap) 10.5.0\n",
)

command_test(
    name = "driver-version",
    args = [
        "$(location :version-line.txt)",
        "$(location :version-expected.txt)",
    ],
    tool = CMP,
)

write_file(
    name = "cpp-input.c",
    content = "#define TWICE(x) ((x)+(x))\nTWICE(21)\n",
)

write_file(
    name = "cpp-expected.txt",
    content = "((21)+(21))\n",
)

generate(
    name = "cpp-output.txt",
    args = [
        "-B$(location :stage1-native-tools)/",
        "-nostdinc",
        "-P",
        "-frandom-seed=bootstrap",
        "$(location :cpp-input.c)",
    ],
    capture = CAPTURE,
    tool = ":stage1-cpp",
)

command_test(
    name = "driver-preprocessing",
    args = [
        "$(location :cpp-output.txt)",
        "$(location :cpp-expected.txt)",
    ],
    tool = CMP,
)

[
    [
        generate(
            name = stage + "-runtime-" + name + "-" + opt + "-program",
            args = [
                "-" + opt,
                "-g0",
                "-frandom-seed=bootstrap",
                "-Werror",
            ] + extra + [
                "$(location " + source + ")",
                "-o",
                "program",
            ],
            chdir = "cellar//bootstrap/stage0-posix/cellar-extra:chdirenv",
            directory = True,
            files = ["program"],
            tool = ":" + stage + "-gcc",
        ),
        command_test(
            name = stage + "-runtime-" + name + "-" + opt,
            args = [
                "0",
                "$(location :" + stage + "-runtime-" + name + "-" + opt + "-program[program])",
            ] + ([
                "startup",
                "ok",
            ] if name == "startup" else []),
            env = {"BOOTSTRAP_TEST": "present"},
            tool = EXPECT_EXIT,
        ),
    ]
    for stage in STAGES
    for opt in [
        "O0",
        "O2",
    ]
    for name, source, extra in [
        ("integer-complex", "cellar//bootstrap/stage1/gcc40:tests/libgcc.c", []),
        (
            "unwind",
            "cellar//bootstrap/stage1/gcc40:tests/unwind.c",
            [
                "-fexceptions",
                "-fno-optimize-sibling-calls",
            ],
        ),
        (
            "extended-float",
            GCC47 + ":tests/extended-float.c",
            [],
        ),
        (
            "c-language",
            "cellar//bootstrap/stage1/gcc40:tests/c-language.c",
            ["-std=gnu99"],
        ),
        ("startup", "cellar//bootstrap/stage1/musl:test-source[tests/runtime.c]", []),
        ("threads", "cellar//bootstrap/stage1/musl:test-source[tests/threads.c]", []),
        ("math", "cellar//bootstrap/stage1/musl:test-source[tests/native-math.c]", []),
        ("unicode", "cellar//bootstrap/stage1/musl:test-source[tests/unicode.c]", []),
        (
            "pthread-option",
            GCC47 + ":tests/pthread-option.c",
            ["-pthread"],
        ),
        # The driver adds upstream's x86 math startup files: crtfastmath.o
        # for -ffast-math and crtprec32.o for -mpc32.
        (
            "floating-point-default",
            GCC47 + ":tests/floating-point-environment.c",
            [],
        ),
        (
            "fast-math",
            GCC47 + ":tests/floating-point-environment.c",
            [
                "-ffast-math",
                "-DEXPECT_FAST_MATH=1",
            ],
        ),
        (
            "x87-precision",
            GCC47 + ":tests/floating-point-environment.c",
            [
                "-mpc32",
                "-DEXPECT_PRECISION=0",
            ],
        ),
    ]
]

# libgcc installs gcov.h, which declares libgcov's runtime interface.
write_file(
    name = "gcov-interface.c",
    content = "#include <gcov.h>\nint main(void) { __gcov_reset(); __gcov_dump(); return 0; }\n",
)

[
    [
        generate(
            name = stage + "-gcov-interface-program",
            args = [
                "-O2",
                "-g0",
                "-frandom-seed=bootstrap",
                "-Werror",
                "$(location :gcov-interface.c)",
                "-lgcov",
                "-o",
                "program",
            ],
            chdir = "cellar//bootstrap/stage0-posix/cellar-extra:chdirenv",
            directory = True,
            files = ["program"],
            tool = ":" + stage + "-gcc",
        ),
        command_test(
            name = stage + "-runtime-gcov-interface",
            args = [
                "0",
                "$(location :" + stage + "-gcov-interface-program[program])",
            ],
            tool = EXPECT_EXIT,
        ),
    ]
    for stage in STAGES
]

# -nolibc drops -lc from the link, so a program with its own entry point
# links against a library directory without libc.a.
write_file(
    name = "entry.c",
    content = 'void _start(void) { __asm__ volatile ("syscall" : : "a"(60), "D"(0)); __builtin_unreachable(); }\n',
)

filegroup(
    name = "libgcc-only",
    srcs = {"lib/libgcc.a": ":stage1-libgcc.a"},
)

command_test(
    name = "driver-nolibc",
    args = [
        "0",
        "$(exe :stage1-xgcc)",
        "-B$(location :stage1-native-tools)/",
        "-B$(location :libgcc-only)/lib/",
        "-nostdinc",
        "-nostartfiles",
        "-nolibc",
        "$(location :entry.c)",
        "-o",
        "/dev/null",
    ],
    env = {"TMPDIR": "."},
    tool = EXPECT_EXIT,
)

command_test(
    name = "runtime-missing-library",
    args = [
        "1",
        "$(exe :stage1-xgcc)",
        "-B$(location :stage1-native-tools)/",
        "-B$(location :stage1-runtime)/lib/",
        "-nostdlib",
        "$(location :tiny.c)",
        "-lstdc++",
        "-o",
        "/dev/null",
    ],
    env = {
        "TMPDIR": ".",
        "PATH": "/usr/bin:/bin",
    },
    host_paths = True,
    tool = EXPECT_EXIT,
)

[
    command_test(
        name = "driver-reject-" + name,
        args = [
            "1",
            "$(exe :stage1-xgcc)",
            "-B$(location :stage1-native-tools)/",
            "-B$(location :stage1-runtime)/lib/",
            "-" + name,
            "$(location :tiny.c)",
            "-o",
            "/dev/null",
        ],
        env = {"TMPDIR": "."},
        tool = EXPECT_EXIT,
    )
    for name in [
        "shared",
        "pie",
        "static-pie",
        "m32",
    ]
]

command_test(
    name = "runtime-reject-glibc-split-stack",
    args = [
        "1",
        "$(exe :stage1-cc1)",
        "-quiet",
        "-frandom-seed=bootstrap",
        "-fsplit-stack",
        "$(location :tiny.c)",
        "-o",
        "/dev/null",
    ],
    tool = EXPECT_EXIT,
)

c_object(
    name = "coverage-runner.o",
    src = "tests/coverage-runner.c",
    flags = [
        "-O2",
        "-Werror",
    ],
    toolchain = HOST_CC["stage1"],
)

c_binary(
    name = "coverage-runner",
    end_objects = HOST_CRTN["stage1"],
    libraries = HOST_LIBC["stage1"],
    objects = HOST_CRT["stage1"] + [":coverage-runner.o"],
    toolchain = HOST_CC["stage1"],
)

write_file(
    name = "coverage-passed",
    content = "passed\n",
)

[
    [
        generate(
            name = stage + "-coverage-result",
            args = [
                "$(exe :" + stage + "-xgcc)",
                "$(location :" + stage + "-native-tools)",
                "$(location :" + stage + "-runtime)/lib/",
                "$(location :compiler-headers)",
                "$(location :" + stage + "-runtime[include])",
                "$(location " + GCC47 + ":tests/coverage.c)",
                "$(exe :" + stage + "-gcov)",
            ],
            chdir = "cellar//bootstrap/stage0-posix/cellar-extra:chdirenv",
            directory = True,
            env = {"TMPDIR": "."},
            files = ["passed"],
            tool = ":coverage-runner",
        ),
        command_test(
            name = stage + "-runtime-coverage",
            args = [
                "$(location :" + stage + "-coverage-result[passed])",
                "$(location :coverage-passed)",
            ],
            tool = CMP,
        ),
    ]
    for stage in STAGES
]

# The previous stage's C++ compiler and library build the next stage.
[
    compiler(
        name = stage + "-host-g++",
        abi = "x86_64-sysv",
        archive_flags = ["crsD"],
        archive_format = "ar",
        archiver = "cellar//bootstrap/stage1/binutils:ar",
        cflags = REPRODUCIBLE_FLAGS,
        compiler = LIBSTDCXX10 + ":" + stage + "-g++",
        execution_runtime = MUSL + ":runtime",
        family = "gcc",
        ldflags = ["-static"],
        linker = "cellar//bootstrap/stage1/binutils:ld",
        object_format = "elf64-x86-64",
        stage = "gcc-10.5.0-" + stage + "-c++",
        sysroot = ":" + stage + "-runtime",
        target_compatible_with = [
            "cellar//bootstrap/platforms:linux",
            "cellar//bootstrap/platforms:amd64",
        ],
    )
    for stage in PREDECESSOR.values()
]

# Upstream bootstrap compares the stage2 and stage3 objects. The two checksum
# objects encode their own stage's link inputs and are the only exclusions.
COMPARED = ["gen-" + name + ".o" for name in [
    "makeucnid",
    "crc-generator",
    "decDPD",
    "wcwidth",
    "bid",
]] + [
    library + "-" + name.replace("/", "-") + ".o"
    for library, (sources, language, includes) in LIBRARIES.items()
    for name in sources
] + ["build-" + name + ".o" for name in GENERATOR_OBJECTS] + [
    "cc-" + name.replace("/", "-") + ".o"
    for name in COMPILER_OBJECTS
] + ["zlib-" + name + ".o" for name in ZLIB_OBJECTS] + [
    "driver-" + name.replace("/", "-") + ".o"
    for name in DRIVER_OBJECTS
] + ["libgcc-" + name + ".o" for name, source, defines, flags in LIBGCC_OBJECTS] + [
    "libgcov-" + name + ".o"
    for name, source, define in LIBGCOV_OBJECTS
] + [
    "crtbeginT.o",
    "crtend.o",
    "crtprec32.o",
    "crtprec64.o",
    "crtprec80.o",
    "crtfastmath.o",
] + [name + ".a" for name in [
    "libiberty",
    "libcpp",
    "libdecnumber",
    "libbacktrace",
    "libbackend",
    "libcommon",
    "libcommon-target",
    "libz",
    "libgcc",
    "libgcov",
]]

[
    command_test(
        name = "compare-" + name,
        args = [
            "$(location :stage2-" + name + ")",
            "$(location :stage3-" + name + ")",
        ],
        tool = CMP,
    )
    for name in COMPARED
]

filegroup(
    name = "stage-comparison",
    srcs = {},
    tests = [":compare-" + name for name in COMPARED],
)

# The compilers link libbacktrace, whose BSD notice is in its source headers.
generate(
    name = "libbacktrace-notice",
    args = [
        "-n",
        "-e",
        "2,31{s|  \\*/$||;p;}",
        "$(location :gcc-10.5.0[libbacktrace/backtrace.h])",
    ],
    capture = CAPTURE,
    output = "LICENSE",
    tool = SED,
)

# The notice runs from the copyright line to the end of the disclaimer.
generate(
    name = "libbacktrace-notice-extent.txt",
    args = [
        "-n",
        "-e",
        "1p",
        "-e",
        "$p",
        "-e",
        "$=",
        "$(location :libbacktrace-notice)",
    ],
    capture = CAPTURE,
    tool = SED,
)

write_file(
    name = "libbacktrace-notice-expected.txt",
    content = "   Copyright (C) 2012-2020 Free Software Foundation, Inc.\nPOSSIBILITY OF SUCH DAMAGE.\n30\n",
)

command_test(
    name = "libbacktrace-license",
    args = [
        "$(location :libbacktrace-notice-extent.txt)",
        "$(location :libbacktrace-notice-expected.txt)",
    ],
    tool = CMP,
)

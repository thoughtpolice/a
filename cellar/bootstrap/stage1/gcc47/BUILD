# SPDX-FileCopyrightText: 2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

load("@cellar//bootstrap:actions.bzl", "command_test", "concatenate", "configured_tool", "generate")
load("@cellar//bootstrap:defs.bzl", "export_file", "filegroup")
load("@cellar//bootstrap:source.bzl", "download_file", "exact_patch", "untar", "write_file")
load("@cellar//bootstrap/stage1:defs.bzl", "bootstrap_artifact", "c_binary", "c_library", "c_object", "compiler", "sysroot")
load(":sources.bzl", "COMPILER_FILES", "DRIVER_FILES", "EARLY_GENERATOR_FILES", "GTYPE_FILES", "LIBRARY_FILES", "MACHINE_GENERATOR_FILES", "RUNTIME_FILES")

PREDECESSOR = "cellar//bootstrap/stage1/gcc40-rebuilt:gcc"

GCC40 = "cellar//bootstrap/stage1/gcc40-rebuilt"

MUSL = "cellar//bootstrap/stage1/musl12"

CRT = [
    MUSL + ":crt1.o",
    MUSL + ":crti.o",
    GCC40 + ":crtbeginT.o",
]

CRTN = [
    GCC40 + ":crtend.o",
    MUSL + ":crtn.o",
]

LIBC = [
    MUSL + ":libc.a",
    GCC40 + ":libgcc.a",
    MUSL + ":libc.a",
]

SOURCE_ALIAS = "cellar//bootstrap/stage1/tools:source-alias"

CAPTURE = "cellar//bootstrap/stage1/tools:capture"

SED = "cellar//bootstrap/stage1/sed:sed"

CMP = "cellar//bootstrap/stage0-posix/cellar-extra:bytecmp"

GENERATOR_INPUTS = [
    "libcpp/makeucnid.c",
    "libcpp/ucnid.tab",
    "libdecnumber/decDPDSymbols.h",
]

# Mixed handwritten/generated CRC source is split before compiler consumption.
# Shipped generated headers and the complete CRC file are comparison fixtures.
FIXTURES = [
    "libcpp/ucnid.h",
    "libdecnumber/decDPD.h",
    "libiberty/crc32.c",
    "libdecnumber/bid/bid2dpd_dpd2bid.h",
]

download_file(
    name = "gcc-4.7.4.tar.bz2",
    hash = "92e61c6dc3a0a449e62d72a38185fda550168a86702dea07125ebd3ec3996282",
    size_bytes = 82935453,
    urls = ["https://mirrors.kernel.org/gnu/gcc/gcc-4.7.4/gcc-4.7.4.tar.bz2"],
)

generate(
    name = "gcc.tar",
    args = [
        "--file",
        "$(location :gcc-4.7.4.tar.bz2)",
        "--output",
    ],
    tool = "cellar//bootstrap/stage0-posix/mescc-tools-extra:unbz2",
)

untar(
    name = "gcc-4.7.4",
    chdirenv = "cellar//bootstrap/stage0-posix/cellar-extra:chdirenv",
    files = GENERATOR_INPUTS + FIXTURES + LIBRARY_FILES + EARLY_GENERATOR_FILES + MACHINE_GENERATOR_FILES + GTYPE_FILES + COMPILER_FILES + DRIVER_FILES + RUNTIME_FILES + [
        "COPYING.RUNTIME",
        "COPYING3",
    ],
    flags = [
        "--numeric-owner",
        "-xf",
    ],
    input = ":gcc.tar",
    untar = "cellar//bootstrap/stage1/tar:tar",
)

[
    download_file(
        name = name + "-4.0.1.txt",
        hash = digest,
        size_bytes = size,
        urls = ["https://www.unicode.org/Public/4.0-Update1/" + name + "-4.0.1.txt"],
    )
    for name, digest, size in [
        ("UnicodeData", "de54d68f2df927a20ea4a83dfd74a543ca7f3e3df2441576e7f6a185ec6fa217", 897402),
        ("DerivedNormalizationProps", "19869bd14f83b74e7f09debcb6ccb3ad7b92cac270684fe4f3846688d4be5254", 198305),
    ]
]

[
    generate(
        name = name,
        args = args + ["$(location :gcc-4.7.4[libiberty/crc32.c])"],
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

[export_file(name = name) for name in [
    "generators/decDPD.c",
    "generators/decDPD.preamble",
]]

# The checked-in header received the 2009 copyright update, but its generator's
# output string did not. Preserve the published notice when regenerating it.
exact_patch(
    name = "makeucnid-notice.c",
    src = ":gcc-4.7.4[libcpp/makeucnid.c]",
    after = "Copyright (C) 2003, 2005, 2009 Free Software Foundation, Inc.",
    before = "Copyright (C) 2003, 2005 Free Software Foundation, Inc.",
    output = "makeucnid.c",
)

# The final sentinel flush must not read element 65536 of the 65536-entry arrays.
exact_patch(
    name = "makeucnid.c",
    src = ":makeucnid-notice.c",
    after = "\tif (i == 65536) break;\n\tlast_flag = flags[i];",
    before = "\tlast_flag = flags[i];",
    output = "makeucnid.c",
)

filegroup(
    name = "generator-source",
    srcs = {
        "makeucnid.c": ":makeucnid.c",
        "crc-generator.c": ":crc-generator.c",
        "decDPD.c": ":generators/decDPD.c",
    },
)

# Every compiler stage will instantiate these genuine source generators anew.
STAGES = {
    "stage1": PREDECESSOR,
    "stage2": ":stage1-gcc",
    "stage3": ":stage2-gcc",
}

# Executable generators and compilers link the predecessor's support runtime.
# Target libraries below are built by, and belong to, the newly built compiler.
HOST_GCC = {
    "stage1": GCC40 + ":",
    "stage2": ":stage1-",
    "stage3": ":stage2-",
}

HOST_CRT = {stage: [
    MUSL + ":crt1.o",
    MUSL + ":crti.o",
    prefix + "crtbeginT.o",
] for stage, prefix in HOST_GCC.items()}

HOST_CRTN = {stage: [
    prefix + "crtend.o",
    MUSL + ":crtn.o",
] for stage, prefix in HOST_GCC.items()}

HOST_LIBC = {stage: [
    MUSL + ":libc.a",
    prefix + "libgcc.a",
    MUSL + ":libc.a",
] for stage, prefix in HOST_GCC.items()}

REPRODUCIBLE_FLAGS = [
    "-frandom-seed=bootstrap",
    "-g0",
    "-Wno-builtin-macro-redefined",
    '-D__DATE__="Jan  1 1970"',
    '-D__TIME__="00:00:00"',
    '-D__TIMESTAMP__="Thu Jan  1 00:00:00 1970"',
]

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
            toolchain = predecessor,
        ),
        c_binary(
            name = stage + "-gen-" + name,
            libraries = HOST_LIBC[stage],
            objects = HOST_CRT[stage] + [":" + stage + "-gen-" + name + ".o"] + HOST_CRTN[stage],
            toolchain = predecessor,
        ),
    ]
    for stage, predecessor in STAGES.items()
    for name in [
        "makeucnid",
        "crc-generator",
        "decDPD",
    ]
]

[
    [
        generate(
            name = stage + "-ucnid.h",
            args = [
                "$(location :gcc-4.7.4[libcpp/ucnid.tab])",
                "$(location :UnicodeData-4.0.1.txt)",
                "$(location :DerivedNormalizationProps-4.0.1.txt)",
            ],
            capture = CAPTURE,
            output = "ucnid.h",
            tool = ":" + stage + "-gen-makeucnid",
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
            tool = "cellar//bootstrap/stage0-posix/mescc-tools-extra:catm",
        ),
        generate(
            name = stage + "-decimal-tables",
            capture = CAPTURE,
            tool = ":" + stage + "-gen-decDPD",
        ),
        concatenate(
            name = stage + "-decDPD.h",
            inputs = [
                ":generators/decDPD.preamble",
                ":" + stage + "-decimal-tables",
            ],
            output = "decDPD.h",
            tool = "cellar//bootstrap/stage0-posix/mescc-tools-extra:catm",
        ),
        command_test(
            name = stage + "-unicode-regeneration",
            args = [
                "$(location :" + stage + "-ucnid.h)",
                "$(location :gcc-4.7.4[libcpp/ucnid.h])",
            ],
            tool = CMP,
        ),
        command_test(
            name = stage + "-crc-regeneration",
            args = [
                "$(location :" + stage + "-crc32.c)",
                "$(location :gcc-4.7.4[libiberty/crc32.c])",
            ],
            tool = CMP,
        ),
    ]
    for stage in STAGES
]

[
    [
        filegroup(
            name = "decimal-" + kind,
            srcs = {
                "decDPD.h": header,
                "decDPDSymbols.h": ":gcc-4.7.4[libdecnumber/decDPDSymbols.h]",
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
            toolchain = PREDECESSOR,
        ),
        c_binary(
            name = "decimal-" + kind + "-program",
            libraries = LIBC,
            objects = CRT + [":decimal-" + kind + ".o"] + CRTN,
            toolchain = PREDECESSOR,
        ),
        generate(
            name = "decimal-" + kind + "-values",
            capture = CAPTURE,
            tool = ":decimal-" + kind + "-program",
        ),
    ]
    for kind, header in [
        (
            stage + "-regenerated",
            ":" + stage + "-decDPD.h",
        )
        for stage in STAGES
    ] + [
        ("fixture", ":gcc-4.7.4[libdecnumber/decDPD.h]"),
    ]
]

# Each stage compiles its own libdecnumber from the tables it generated, so a
# miscompiled generator in any stage must fail here.
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
        "$(location :gcc-4.7.4[libdecnumber/bid/bid2dpd_dpd2bid.h])",
    ],
    capture = CAPTURE,
    tool = SED,
)

export_file(name = "generators/bid-tables.c")

[
    [
        filegroup(
            name = stage + "-bid-generator-source",
            srcs = {
                "bid-tables.c": ":generators/bid-tables.c",
                "decDPD.h": ":" + stage + "-decDPD.h",
                "decDPDSymbols.h": ":gcc-4.7.4[libdecnumber/decDPDSymbols.h]",
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
            toolchain = predecessor,
        ),
        c_binary(
            name = stage + "-gen-bid",
            libraries = ["cellar//bootstrap/stage1/gmp:libgmp.a"] + HOST_LIBC[stage],
            objects = HOST_CRT[stage] + [":" + stage + "-gen-bid.o"] + HOST_CRTN[stage],
            toolchain = predecessor,
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
            tool = "cellar//bootstrap/stage0-posix/mescc-tools-extra:catm",
        ),
    ]
    for stage, predecessor in STAGES.items()
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
            toolchain = PREDECESSOR,
        ),
        c_binary(
            name = "bid-" + kind + "-program",
            libraries = LIBC,
            objects = CRT + [":bid-" + kind + ".o"] + CRTN,
            toolchain = PREDECESSOR,
        ),
        generate(
            name = "bid-" + kind + "-values",
            capture = CAPTURE,
            tool = ":bid-" + kind + "-program",
        ),
    ]
    for kind, header in [
        (
            stage + "-regenerated",
            ":" + stage + "-bid2dpd_dpd2bid.h",
        )
        for stage in STAGES
    ] + [
        ("fixture", ":gcc-4.7.4[libdecnumber/bid/bid2dpd_dpd2bid.h]"),
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

# Upstream REQUIRED_OFILES, libcpp_a_OBJS and native BID libdecnumber objects.

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
    "dyn-string",
    "fdmatch",
    "fibheap",
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
    "safe-ctype",
    "simple-object",
    "simple-object-coff",
    "simple-object-elf",
    "simple-object-mach-o",
    "sort",
    "spaces",
    "splay-tree",
    "stack-limit",
    "strerror",
    "strsignal",
    "timeval-utils",
    "unlink-if-ordinary",
    "xatexit",
    "xexit",
    "xmalloc",
    "xmemdup",
    "xstrdup",
    "xstrerror",
    "xstrndup",
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
    "HAVE_STRRCHR",
    "HAVE_STRSIGNAL",
    "HAVE_STRSTR",
    "HAVE_STRTOD",
    "HAVE_STRTOL",
    "HAVE_STRTOUL",
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
    "HAVE_DECL_BASENAME",
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
    "HAVE_DECL_STRVERSCMP",
    "HAVE_DECL_VASPRINTF",
    "HAVE_DECL_VSNPRINTF",
]

LIBRARY_CONFIG_VALUES = {
    "SIZEOF_INT": "4",
    "SIZEOF_LONG": "8",
    "SIZEOF_LONG_LONG": "8",
    "SIZEOF_SIZE_T": "8",
    "SIZEOF_VOID_P": "8",
    "STACK_DIRECTION": "-1",
    "HOST_WIDE_INT": "long",
    "UNSIGNED_64BIT_TYPE": "unsigned long",
    "ICONV_CONST": "",
    "PACKAGE": "\"gcc\"",
    "PACKAGE_VERSION": "\"4.7.4\"",
    "SIZEOF_CHAR": "1",
    "SIZEOF_SHORT": "2",
    "HAVE_DECL_FPRINTF_UNLOCKED": "0",
}

write_file(
    name = "library-config.h",
    content = "#ifndef GCC47_LIBRARY_CONFIG_H\n#define GCC47_LIBRARY_CONFIG_H 1\n#ifndef _GNU_SOURCE\n#define _GNU_SOURCE 1\n#endif\n" + "\n".join(["#define " + name + " 1" for name in LIBRARY_CONFIG_ON]) + "\n" + "\n".join(["#define " + name + " " + value for name, value in LIBRARY_CONFIG_VALUES.items()]) + "\n#endif\n",
)

write_file(
    name = "localedir.h",
    content = '#define LOCALEDIR "/nonexistent-bootstrap-locale"\n',
)

write_file(
    name = "gstdint.h",
    content = "#include <stdint.h>\n",
)

[export_file(name = path) for path in [
    "patches/tmpdir.patch",
]]

exact_patch(
    name = "make-temp-file.c",
    src = ":gcc-4.7.4[libiberty/make-temp-file.c]",
    output = "make-temp-file.c",
    patch = ":patches/tmpdir.patch",
)

[
    filegroup(
        name = stage + "-library-source",
        srcs = {path: ":gcc-4.7.4[" + path + "]" for path in LIBRARY_FILES if path != "libiberty/make-temp-file.c"} | {
            "gcc/config/i386/cpuid.h": ":gcc-4.7.4[gcc/config/i386/cpuid.h]",
            "libiberty/config.h": ":library-config.h",
            "libiberty/make-temp-file.c": ":make-temp-file.c",
            "libiberty/crc32.c": ":" + stage + "-crc32.c",
            "libcpp/config.h": ":library-config.h",
            "libcpp/localedir.h": ":localedir.h",
            "libcpp/ucnid.h": ":" + stage + "-ucnid.h",
            "libdecnumber/config.h": ":library-config.h",
            "libdecnumber/gstdint.h": ":gstdint.h",
            "libdecnumber/decDPD.h": ":" + stage + "-decDPD.h",
            "libdecnumber/bid/bid2dpd_dpd2bid.h": ":" + stage + "-bid2dpd_dpd2bid.h",
        },
    )
    for stage in STAGES
]

LIBRARIES = {
    "libiberty": (
        LIBIBERTY,
        [
            "libiberty",
            "include",
        ],
    ),
    "libcpp": (
        LIBCPP,
        [
            "libcpp",
            "libcpp/include",
            "include",
        ],
    ),
    "libdecnumber": (
        LIBDECNUMBER,
        [
            "libdecnumber",
            "libdecnumber/bid",
        ],
    ),
}

[
    c_object(
        name = stage + "-" + library + "-" + name.replace("/", "-") + ".o",
        src = ":" + stage + "-library-source[" + library + "/" + name + ".c]",
        defines = ["HAVE_CONFIG_H=1"],
        flags = [
            "-O2",
            "-Werror",
        ],
        headers = [":" + stage + "-library-source"],
        logical_includes = includes,
        logical_source = library + "/" + name + ".c",
        object_name = library + str(i) + ".o",
        source_alias = SOURCE_ALIAS,
        source_tree = ":" + stage + "-library-source",
        toolchain = predecessor,
    )
    for stage, predecessor in STAGES.items()
    for library, (sources, includes) in LIBRARIES.items()
    for i, name in enumerate(sources)
]

[
    c_library(
        name = stage + "-" + library + ".a",
        objects = [":" + stage + "-" + library + "-" + name.replace("/", "-") + ".o" for name in sources],
        output = library + ".a",
        toolchain = predecessor,
    )
    for stage, predecessor in STAGES.items()
    for library, (sources, includes) in LIBRARIES.items()
]

[
    [
        c_object(
            name = name + "-test.o",
            src = "tests/" + name + ".c",
            flags = [
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
            ],
            toolchain = PREDECESSOR,
        ),
        c_binary(
            name = name + "-test-bin",
            libraries = [
                ":stage1-libcpp.a",
                ":stage1-libiberty.a",
                ":stage1-libdecnumber.a",
            ] + LIBC,
            objects = CRT + [":" + name + "-test.o"] + CRTN,
            toolchain = PREDECESSOR,
        ),
    ]
    for name in [
        "libiberty",
        "cpp",
        "decimal",
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
    tool = "cellar//bootstrap/stage1/tools:expect-exit",
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
    tool = "cellar//bootstrap/stage1/tools:expect-exit",
)

[filegroup(
    name = stage + "-support-libraries",
    srcs = {name + ".a": ":" + stage + "-" + name + ".a" for name in LIBRARIES},
) for stage in STAGES]

TARGET_PATCH_CHAIN = [
    [
        "patched-0005-0",
        ":gcc-4.7.4[gcc/config/linux.h]",
        "0005-0",
    ],
    [
        "patched-0005-1",
        ":patched-0005-0",
        "0005-1",
    ],
    [
        "patched-0005-2",
        ":patched-0005-1",
        "0005-2",
    ],
    [
        "patched-0005-3",
        ":patched-0005-2",
        "0005-3",
    ],
    [
        "patched-0005-4",
        ":gcc-4.7.4[gcc/config/linux.opt]",
        "0005-4",
    ],
    [
        "patched-0006-0",
        ":gcc-4.7.4[gcc/config/glibc-stdint.h]",
        "0006-0",
    ],
    [
        "patched-0006-1",
        ":patched-0006-0",
        "0006-1",
    ],
    [
        "patched-0006-2",
        ":patched-0005-3",
        "0006-2",
    ],
    [
        "patched-0007-0",
        ":gcc-4.7.4[gcc/config/i386/linux64.h]",
        "0007-0",
    ],
    [
        "patched-0008-0",
        ":patched-0006-2",
        "0008-0",
    ],
]

TARGET_PATCHES = {
    "gcc/config/linux.opt": ":patched-0005-4",
    "gcc/config/glibc-stdint.h": ":patched-0006-1",
    "gcc/config/linux.h": ":patched-0008-0",
    "gcc/config/i386/linux64.h": ":patched-0007-0",
}

[export_file(name = "patches/" + stem + ".patch") for name, source, stem in TARGET_PATCH_CHAIN]

[
    exact_patch(
        name = name,
        src = source,
        patch = ":patches/" + stem + ".patch",
    )
    for name, source, stem in TARGET_PATCH_CHAIN
]

TARGET_HEADERS = [
    "i386/biarch64.h",
    "i386/i386.h",
    "linux-android.h",
    "i386/unix.h",
    "i386/att.h",
    "dbxelf.h",
    "elfos.h",
    "gnu-user.h",
    "glibc-stdint.h",
    "i386/x86-64.h",
    "i386/gnu-user64.h",
    "linux.h",
    "i386/linux64.h",
]

# Reviewed GCC 4.7 native host, GNU binutils 2.30 and static musl target.
GCC_CONFIG_ON = [
    "HAVE_LONG_LONG",
    "HAVE_STDBOOL_H",
    "HAVE__BOOL",
    "HAVE_DESIGNATED_INITIALIZERS",
    "HAVE_SYS_PARAM_H",
    "HAVE_SYS_TIMES_H",
    "HAVE_SYS_SELECT_H",
    "HAVE_SYS_RESOURCE_H",
    "HAVE_GETRLIMIT",
    "HAVE_SETRLIMIT",
    "HAVE_GETTIMEOFDAY",
    "HAVE_CLOCK_T",
    "HAVE_STRUCT_TMS",
    "HAVE_TIMES",
    "HAVE_DECL_ATOF",
    "HAVE_DECL_ATOL",
    "HAVE_DECL_CALLOC",
    "HAVE_DECL_CLOCK",
    "HAVE_DECL_FREE",
    "HAVE_DECL_GETCWD",
    "HAVE_DECL_GETENV",
    "HAVE_DECL_GETPAGESIZE",
    "HAVE_DECL_MALLOC",
    "HAVE_DECL_REALLOC",
    "HAVE_DECL_SBRK",
    "HAVE_DECL_SNPRINTF",
    "HAVE_DECL_STRSTR",
    "HAVE_DECL_TIMES",
    "HAVE_DECL_VASPRINTF",
    "HAVE_INTTYPES_H",
    "HAVE_STDINT_H",
    "HAVE_UINTPTR_T",
    "HAVE_AS_DWARF2_DEBUG_LINE",
    "HAVE_AS_GDWARF2_DEBUG_FLAG",
    "HAVE_AS_GOTOFF_IN_DATA",
    "HAVE_AS_GSTABS_DEBUG_FLAG",
    "HAVE_AS_LEB128",
    "HAVE_AS_TLS",
    "HAVE_GAS_BALIGN_AND_P2ALIGN",
    "HAVE_GAS_MAX_SKIP_P2ALIGN",
    "HAVE_GAS_HIDDEN",
    "HAVE_GAS_COMDAT_GROUP",
    "HAVE_GAS_FILDS_FISTS",
    "HAVE_GAS_SHF_MERGE",
    "HAVE_GAS_SUBSECTION_ORDERING",
    "HAVE_GAS_WEAK",
    "HAVE_LD_EH_FRAME_HDR",
    "HAVE_LD_RO_RW_SECTION_MIXING",
    "HAVE_LD_AS_NEEDED",
    "HAVE_LD_PIE",
    "HAVE_LD_STATIC_DYNAMIC",
    "HAVE_LD_DEMANGLE",
    "HAVE_INITFINI_ARRAY",
    "HAVE_MMAP_FILE",
    "HAVE_MMAP_ANON",
    "HAVE_MMAP_DEV_ZERO",
    "HAVE_LSTAT",
    "HAVE_FTRUNCATE",
    "HAVE_FSTAT",
    "HAVE_GETRUSAGE",
    "HAVE_SETLOCALE",
    "HAVE_LANGINFO_CODESET",
    "NEED_64BIT_HOST_WIDE_INT",
    "ENABLE_ASSERT_CHECKING",
    "ENABLE_CHECKING",
    "ENABLE_TREE_CHECKING",
    "ENABLE_GC_CHECKING",
    "ENABLE_TYPES_CHECKING",
    "ENABLE_DECIMAL_BID_FORMAT",
    "ENABLE_DECIMAL_FLOAT",
    "HAVE_DIRENT_H",
    "HAVE_UINTMAX_T",
    "HAVE_INTMAX_T",
    "HAVE_LONG_LONG_INT",
    "HAVE_UNSIGNED_LONG_LONG_INT",
    "HAVE_FSEEKO",
    "HAVE_FTELLO",
    "HAVE_DECL_STRNLEN",
    "HAVE_STRNLEN",
    "HAVE_FLEX",
    "HAVE_GAS_CFI_PERSONALITY_DIRECTIVE",
    "HAVE_COMDAT_GROUP",
    "HAVE_GAS_CFI_DIRECTIVE",
    "HAVE_GAS_CFI_SECTIONS_DIRECTIVE",
    "HAVE_GAS_WEAKREF",
    "HAVE_GAS_LITERAL16",
    "HAVE_GAS_SECTION_EXCLUDE",
    "HAVE_AS_IX86_DIFF_SECT_DELTA",
    "HAVE_AS_IX86_FFREEP",
    "HAVE_AS_IX86_FILDQ",
    "HAVE_AS_IX86_FILDS",
    "HAVE_AS_IX86_QUAD",
    "HAVE_AS_IX86_REP_LOCK_PREFIX",
    "HAVE_AS_IX86_SAHF",
    "HAVE_AS_IX86_SWAP",
    "HAVE_AS_IX86_TLSGDPLT",
    "HAVE_AS_IX86_TLSLDMPLT",
    "HAVE_LD_BUILDID",
    "TARGET_LIBC_PROVIDES_SSP",
    "TARGET_DL_ITERATE_PHDR",
]

GCC_CONFIG_VALUES = {
    "SIZEOF_SHORT": "2",
    "SIZEOF_CHAR": "1",
    "SIZEOF_DOUBLE": "8",
    "SIZEOF_LONG_DOUBLE": "16",
    "GETGROUPS_T": "gid_t",
    "HOST_EXECUTABLE_SUFFIX": "\"\"",
    "HOST_OBJECT_SUFFIX": "\".o\"",
    "DEFAULT_USE_CXA_ATEXIT": "2",
    "CONFIG_SJLJ_EXCEPTIONS": "0",
    "EXTRA_MODES_FILE": "\"config/i386/i386-modes.def\"",
    "TARGET_SYSTEM_ROOT": "\"/nonexistent-bootstrap-sysroot\"",
    "ENABLE_FIXED_POINT": "0",
    "HAVE_LTO_PLUGIN": "0",
    "DEFAULT_LIBC": "4",
    "LIBC_GLIBC": "1",
    "LIBC_UCLIBC": "2",
    "LIBC_BIONIC": "3",
    "LIBC_MUSL": "4",
    "ANDROID_DEFAULT": "0",
    "SINGLE_LIBC": "1",
    "TM_MULTILIB_CONFIG": "OPTION_MASK_ABI_64",
    "TARGET_CPU_DEFAULT": "TARGET_CPU_DEFAULT_generic",
    "HAVE_DECL_GETRLIMIT": "1",
    "HAVE_DECL_SETRLIMIT": "1",
    "HAVE_DECL_STPCPY": "1",
    "HAVE_DECL_STRSIGNAL": "1",
}

write_file(
    name = "auto-host.h",
    content = '#include "library-config.h"\n' + "\n".join(["#define " + name + " 1" for name in GCC_CONFIG_ON]) + "\n" + "\n".join(["#define " + name + " " + value for name, value in GCC_CONFIG_VALUES.items()]) + "\n",
)

[
    write_file(
        name = name,
        content = '#ifndef GCC47_CONFIG_H\n#define GCC47_CONFIG_H 1\n#include "auto-host.h"\n#ifdef IN_GCC\n#include "ansidecl.h"\n#endif\n#endif\n',
    )
    for name in [
        "config.h",
        "bconfig.h",
    ]
]

write_file(
    name = "tm.h",
    content = "#ifndef GCC47_TM_H\n#define GCC47_TM_H 1\n#ifdef IN_GCC\n" + "\n".join(['#include "config/' + p + '"' for p in TARGET_HEADERS]) + '\n#endif\n#if defined IN_GCC && !defined GENERATOR_FILE && !defined USED_FOR_TARGET\n#include "insn-flags.h"\n#endif\n#include "defaults.h"\n#undef TARGET_CAN_SPLIT_STACK\n#undef TARGET_THREAD_SPLIT_STACK_OFFSET\n#endif\n',
)

write_file(
    name = "tm_p.h",
    content = '#ifndef GCC_TM_P_H\n#define GCC_TM_P_H 1\n#include "config/i386/i386-protos.h"\n#include "tm-preds.h"\n#endif\n',
)

write_file(
    name = "all-tree.def",
    content = '#include "tree.def"\nEND_OF_BASE_TREE_CODES\n#include "c-family/c-common.def"\n#include "cp/cp-tree.def"\n',
)

write_file(
    name = "bversion.h",
    content = "#define BUILDING_GCC_MAJOR 4\n#define BUILDING_GCC_MINOR 7\n#define BUILDING_GCC_PATCHLEVEL 4\n#define BUILDING_GCC_VERSION (BUILDING_GCC_MAJOR * 1000 + BUILDING_GCC_MINOR)\n",
)

GCC_STAGE_SOURCES = {stage: {path: ":gcc-4.7.4[" + path + "]" for path in EARLY_GENERATOR_FILES + MACHINE_GENERATOR_FILES + GTYPE_FILES if path not in TARGET_PATCHES} | TARGET_PATCHES | {
    "include": ":" + stage + "-library-source[include]",
    "libcpp": ":" + stage + "-library-source[libcpp]",
} | {"gcc/" + name: ":" + name for name in [
    "library-config.h",
    "auto-host.h",
    "config.h",
    "bconfig.h",
    "tm.h",
    "tm_p.h",
    "all-tree.def",
    "bversion.h",
]} for stage in STAGES}

[
    filegroup(
        name = stage + "-gcc-source",
        srcs = sources,
    )
    for stage, sources in GCC_STAGE_SOURCES.items()
]

GENERATOR_DEFINES = [
    "_GNU_SOURCE=1",
    "IN_GCC=1",
    "GENERATOR_FILE=1",
]

GENERATOR_INCLUDES = [
    "gcc",
    "include",
    "libcpp/include",
]

BASE_GENERATORS = [
    "gencheck",
    "gengenrtl",
    "genmodes",
    "genhooks",
]

BASE_GENERATED = [
    ("tree-check.h", "gencheck", []),
    ("genrtl.h", "gengenrtl", []),
    (
        "insn-modes.h",
        "genmodes",
        ["-h"],
    ),
    (
        "min-insn-modes.c",
        "genmodes",
        ["-m"],
    ),
    ("insn-modes.c", "genmodes", []),
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
]

[
    c_object(
        name = stage + "-" + name + ".o",
        src = ":" + stage + "-gcc-source[gcc/" + name + ".c]",
        defines = GENERATOR_DEFINES,
        flags = [
            "-O2",
            "-Werror",
        ],
        logical_includes = GENERATOR_INCLUDES,
        logical_source = "gcc/" + name + ".c",
        object_name = name + ".o",
        source_alias = SOURCE_ALIAS,
        source_tree = ":" + stage + "-gcc-source",
        toolchain = predecessor,
    )
    for stage, predecessor in STAGES.items()
    for name in BASE_GENERATORS + ["errors"]
]

[
    c_binary(
        name = stage + "-" + name,
        libraries = [":" + stage + "-libiberty.a"] + HOST_LIBC[stage],
        objects = HOST_CRT[stage] + [
            ":" + stage + "-" + name + ".o",
            ":" + stage + "-errors.o",
        ] + HOST_CRTN[stage],
        toolchain = predecessor,
    )
    for stage, predecessor in STAGES.items()
    for name in BASE_GENERATORS
]

[
    generate(
        name = stage + "-" + output.replace("/", "-"),
        args = args,
        capture = CAPTURE,
        output = output.replace("/", "-"),
        tool = ":" + stage + "-" + tool,
    )
    for stage in STAGES
    for output, tool, args in BASE_GENERATED
]

[
    filegroup(
        name = stage + "-base-generated",
        srcs = {output: ":" + stage + "-" + output.replace("/", "-") for output, tool, args in BASE_GENERATED},
    )
    for stage in STAGES
]

[
    c_object(
        name = stage + "-base-mode-object",
        src = ":" + stage + "-base-generated[min-insn-modes.c]",
        defines = GENERATOR_DEFINES,
        flags = [
            "-O2",
            "-Werror",
        ],
        headers = [":" + stage + "-gcc-source"],
        includes = [
            ":" + stage + "-base-generated",
            ":" + stage + "-gcc-source[gcc]",
            ":" + stage + "-gcc-source[include]",
            ":" + stage + "-library-source[libcpp/include]",
        ],
        logical_source = "min-insn-modes.c",
        source_alias = SOURCE_ALIAS,
        source_tree = ":" + stage + "-base-generated",
        # Generated source has its own tree; explicit source header roots follow.
        toolchain = predecessor,
    )
    for stage, predecessor in STAGES.items()
]

c_object(
    name = "modes-test.o",
    src = "tests/modes.c",
    defines = GENERATOR_DEFINES,
    flags = [
        "-O2",
        "-Werror",
    ],
    # do not sort
    includes = [
        ":stage1-base-generated",
        ":stage1-gcc-source[gcc]",
        ":stage1-gcc-source[include]",
    ],
    toolchain = PREDECESSOR,
)

c_binary(
    name = "modes-test-bin",
    libraries = LIBC,
    objects = CRT + [
        ":modes-test.o",
        ":stage1-base-mode-object",
    ] + CRTN,
    toolchain = PREDECESSOR,
)

command_test(
    name = "native-machine-modes",
    tool = ":modes-test-bin",
)

OPTION_FILES = [
    "gcc/c-family/c.opt",
    "gcc/lto/lang.opt",
    "gcc/common.opt",
    "gcc/config/fused-madd.opt",
    "gcc/config/gnu-user.opt",
    "gcc/config/i386/i386.opt",
    "gcc/config/linux.opt",
    "gcc/config/linux-android.opt",
]

[
    generate(
        name = stage + "-optionlist",
        args = [
            "-f",
            "$(location :gcc-4.7.4[gcc/opt-gather.awk])",
        ] + ["$(location :" + stage + "-gcc-source[" + path + "])" for path in OPTION_FILES],
        capture = CAPTURE,
        tool = "cellar//bootstrap/stage1/gawk:gawk",
    )
    for stage in STAGES
]

OPTION_GENERATORS = [
    ("options.h", "opth-gen.awk"),
    ("options.c", "optc-gen.awk"),
    ("options-save.c", "optc-save-gen.awk"),
]

[
    generate(
        name = stage + "-" + output,
        args = [
            "-f",
            "$(location :gcc-4.7.4[gcc/opt-functions.awk])",
            "-f",
            "$(location :gcc-4.7.4[gcc/opt-read.awk])",
            "-f",
            "$(location :gcc-4.7.4[gcc/" + script + "])",
        ] + ([
            "-v",
            "header_name=config.h system.h coretypes.h tm.h",
        ] if output != "options.h" else []),
        capture = CAPTURE,
        output = output,
        stdin = ":" + stage + "-optionlist",
        tool = "cellar//bootstrap/stage1/gawk:gawk",
    )
    for stage in STAGES
    for output, script in OPTION_GENERATORS
]

[
    generate(
        name = stage + "-i386-builtin-types.inc",
        args = [
            "-f",
            "$(location :gcc-4.7.4[gcc/config/i386/i386-builtin-types.awk])",
            "$(location :gcc-4.7.4[gcc/config/i386/i386-builtin-types.def])",
        ],
        capture = CAPTURE,
        tool = "cellar//bootstrap/stage1/gawk:gawk",
    )
    for stage in STAGES
]

[
    filegroup(
        name = stage + "-generator-source",
        srcs = GCC_STAGE_SOURCES[stage] | {"gcc/gtype-desc.h": ":" + stage + "-gtype-output[gtype-desc.h]"} | {"gcc/" + output: ":" + stage + "-" + output.replace("/", "-") for output, tool, args in BASE_GENERATED} | {"gcc/" + output: ":" + stage + "-" + output for output, script in OPTION_GENERATORS} | {"gcc/i386-builtin-types.inc": ":" + stage + "-i386-builtin-types.inc"},
    )
    for stage in STAGES
]

MACHINE_GENERATORS = [
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
    "genrecog",
    "genconstants",
    "genenums",
]

RTL_SUPPORT = [
    "rtl",
    "read-rtl",
    "ggc-none",
    "vec",
    "gensupport",
    "print-rtl",
]

[
    c_object(
        name = stage + "-" + name + ".o",
        src = ":" + stage + "-generator-source[gcc/" + name + ".c]",
        defines = GENERATOR_DEFINES,
        flags = [
            "-O2",
            "-Werror",
        ],
        logical_includes = GENERATOR_INCLUDES,
        logical_source = "gcc/" + name + ".c",
        object_name = name + ".o",
        source_alias = SOURCE_ALIAS,
        source_tree = ":" + stage + "-generator-source",
        toolchain = predecessor,
    )
    for stage, predecessor in STAGES.items()
    for name in MACHINE_GENERATORS + RTL_SUPPORT + ["read-md"]
]

[
    c_binary(
        name = stage + "-" + name,
        libraries = [":" + stage + "-libiberty.a"] + HOST_LIBC[stage],
        objects = HOST_CRT[stage] + [
            ":" + stage + "-" + name + ".o",
            ":" + stage + "-read-md.o",
            ":" + stage + "-errors.o",
        ] + ([":" + stage + "-" + support + ".o" for support in RTL_SUPPORT] + [":" + stage + "-base-mode-object"] if name not in [
            "genconstants",
            "genenums",
        ] else []) + HOST_CRTN[stage],
        toolchain = predecessor,
    )
    for stage, predecessor in STAGES.items()
    for name in MACHINE_GENERATORS
]

EARLY_MD_OUTPUTS = [
    ("insn-constants.h", "genconstants", []),
    ("insn-enums.c", "genenums", []),
    ("gencondmd.c", "genconditions", []),
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
    ("insn-preds.c", "genpreds", []),
]

[
    generate(
        name = stage + "-" + output,
        args = args + ["config/i386/i386.md"],
        capture = CAPTURE,
        inputs = [":" + stage + "-generator-source"],
        output = output,
        tool = ":" + stage + "-" + tool,
        working_directory = ":" + stage + "-generator-source[gcc]",
    )
    for stage in STAGES
    for output, tool, args in EARLY_MD_OUTPUTS
]

[
    filegroup(
        name = stage + "-condition-source",
        srcs = GCC_STAGE_SOURCES[stage] | {"gcc/gtype-desc.h": ":" + stage + "-gtype-output[gtype-desc.h]"} | {"gcc/" + output: ":" + stage + "-" + output.replace("/", "-") for output, tool, args in BASE_GENERATED} | {"gcc/" + output: ":" + stage + "-" + output for output, script in OPTION_GENERATORS} | {"gcc/" + output: ":" + stage + "-" + output for output, tool, args in EARLY_MD_OUTPUTS},
    )
    for stage in STAGES
]

[
    c_object(
        name = stage + "-gencondmd.o",
        src = ":" + stage + "-condition-source[gcc/gencondmd.c]",
        defines = GENERATOR_DEFINES,
        flags = [
            "-O2",
            "-Werror",
        ],
        logical_includes = GENERATOR_INCLUDES,
        logical_source = "gcc/gencondmd.c",
        object_name = "gencondmd.o",
        source_alias = SOURCE_ALIAS,
        source_tree = ":" + stage + "-condition-source",
        toolchain = predecessor,
    )
    for stage, predecessor in STAGES.items()
]

[
    c_binary(
        name = stage + "-gencondmd",
        libraries = [":" + stage + "-libiberty.a"] + HOST_LIBC[stage],
        objects = HOST_CRT[stage] + [":" + stage + "-gencondmd.o"] + HOST_CRTN[stage],
        toolchain = predecessor,
    )
    for stage, predecessor in STAGES.items()
]

[
    generate(
        name = stage + "-insn-conditions.md",
        capture = CAPTURE,
        tool = ":" + stage + "-gencondmd",
    )
    for stage in STAGES
]

MD_OUTPUTS = [
    ("insn-attr.h", "genattr"),
    ("insn-attr-common.h", "genattr-common"),
    ("insn-codes.h", "gencodes"),
    ("insn-config.h", "genconfig"),
    ("insn-flags.h", "genflags"),
    ("insn-attrtab.c", "genattrtab"),
    ("insn-automata.c", "genautomata"),
    ("insn-emit.c", "genemit"),
    ("insn-extract.c", "genextract"),
    ("insn-opinit.c", "genopinit"),
    ("insn-output.c", "genoutput"),
    ("insn-peep.c", "genpeep"),
    ("insn-recog.c", "genrecog"),
]

[
    filegroup(
        name = stage + "-machine-inputs",
        srcs = GCC_STAGE_SOURCES[stage] | {"gcc/insn-conditions.md": ":" + stage + "-insn-conditions.md"},
    )
    for stage in STAGES
]

[
    generate(
        name = stage + "-" + output,
        args = [
            "config/i386/i386.md",
            "insn-conditions.md",
        ],
        capture = CAPTURE,
        inputs = [":" + stage + "-machine-inputs"],
        output = output,
        tool = ":" + stage + "-" + tool,
        working_directory = ":" + stage + "-machine-inputs[gcc]",
    )
    for stage in STAGES
    for output, tool in MD_OUTPUTS
]

[
    filegroup(
        name = stage + "-machine-generated",
        srcs = {output: ":" + stage + "-" + output for output, tool in MD_OUTPUTS} | {output: ":" + stage + "-" + output for output, tool, args in EARLY_MD_OUTPUTS} | {"insn-conditions.md": ":" + stage + "-insn-conditions.md"} | {output: ":" + stage + "-" + output for output, script in OPTION_GENERATORS} | {"i386-builtin-types.inc": ":" + stage + "-i386-builtin-types.inc"},
    )
    for stage in STAGES
]

GTYPE_INPUTS = [
    "libcpp/include/line-map.h",
    "libcpp/include/cpplib.h",
    "gcc/options.h",
    "libcpp/include/cpp-id-data.h",
    "gcc/input.h",
    "gcc/coretypes.h",
    "gcc/vecprim.h",
    "gcc/vecir.h",
    "gcc/config/i386/biarch64.h",
    "gcc/config/i386/i386.h",
    "gcc/config/linux-android.h",
    "gcc/config/i386/unix.h",
    "gcc/config/i386/att.h",
    "gcc/config/dbxelf.h",
    "gcc/config/elfos.h",
    "gcc/config/gnu-user.h",
    "gcc/config/glibc-stdint.h",
    "gcc/config/i386/x86-64.h",
    "gcc/config/i386/gnu-user64.h",
    "gcc/config/linux.h",
    "gcc/config/i386/linux64.h",
    "include/hashtab.h",
    "include/splay-tree.h",
    "gcc/bitmap.h",
    "gcc/alias.h",
    "gcc/coverage.c",
    "gcc/rtl.h",
    "gcc/optabs.h",
    "gcc/tree.h",
    "gcc/libfuncs.h",
    "libcpp/include/symtab.h",
    "include/obstack.h",
    "gcc/real.h",
    "gcc/function.h",
    "gcc/insn-addr.h",
    "gcc/hwint.h",
    "gcc/fixed-value.h",
    "gcc/output.h",
    "gcc/cfgloop.h",
    "gcc/cselib.h",
    "gcc/basic-block.h",
    "gcc/ipa-ref.h",
    "gcc/cgraph.h",
    "gcc/reload.h",
    "gcc/caller-save.c",
    "gcc/alias.c",
    "gcc/bitmap.c",
    "gcc/cselib.c",
    "gcc/cgraph.c",
    "gcc/ipa-prop.c",
    "gcc/ipa-cp.c",
    "gcc/matrix-reorg.c",
    "gcc/dbxout.c",
    "gcc/dwarf2out.h",
    "gcc/dwarf2asm.c",
    "gcc/dwarf2cfi.c",
    "gcc/dwarf2out.c",
    "gcc/tree-vect-generic.c",
    "gcc/dojump.c",
    "gcc/emit-rtl.c",
    "gcc/except.h",
    "gcc/explow.c",
    "gcc/expr.c",
    "gcc/expr.h",
    "gcc/function.c",
    "gcc/except.c",
    "gcc/gcse.c",
    "gcc/godump.c",
    "gcc/integrate.c",
    "gcc/lists.c",
    "gcc/optabs.c",
    "gcc/profile.c",
    "gcc/mcf.c",
    "gcc/reg-stack.c",
    "gcc/cfglayout.c",
    "gcc/cfglayout.h",
    "gcc/sdbout.c",
    "gcc/stor-layout.c",
    "gcc/stringpool.c",
    "gcc/tree.c",
    "gcc/varasm.c",
    "gcc/gimple.h",
    "gcc/gimple.c",
    "gcc/tree-mudflap.c",
    "gcc/tree-flow.h",
    "gcc/tree-ssanames.c",
    "gcc/tree-eh.c",
    "gcc/tree-ssa-address.c",
    "gcc/tree-cfg.c",
    "gcc/tree-dfa.c",
    "gcc/tree-iterator.c",
    "gcc/gimplify.c",
    "gcc/tree-chrec.h",
    "gcc/tree-scalar-evolution.c",
    "gcc/tree-ssa-operands.h",
    "gcc/tree-profile.c",
    "gcc/tree-nested.c",
    "gcc/varpool.c",
    "gcc/tree-parloops.c",
    "gcc/omp-low.c",
    "gcc/targhooks.c",
    "gcc/config/i386/i386.c",
    "gcc/passes.c",
    "gcc/cgraphunit.c",
    "gcc/tree-ssa-propagate.c",
    "gcc/tree-phinodes.c",
    "gcc/lto-symtab.c",
    "gcc/tree-ssa-alias.h",
    "gcc/ipa-prop.h",
    "gcc/trans-mem.c",
    "gcc/lto-streamer.h",
    "gcc/target-globals.h",
    "gcc/ipa-inline.h",
    "[cp]",
    "gcc/cp/rtti.c",
    "gcc/cp/mangle.c",
    "gcc/cp/name-lookup.h",
    "gcc/cp/name-lookup.c",
    "gcc/cp/cp-tree.h",
    "gcc/cp/decl.h",
    "gcc/cp/call.c",
    "gcc/cp/decl.c",
    "gcc/cp/decl2.c",
    "gcc/cp/pt.c",
    "gcc/cp/repo.c",
    "gcc/cp/semantics.c",
    "gcc/cp/tree.c",
    "gcc/cp/parser.h",
    "gcc/cp/parser.c",
    "gcc/cp/method.c",
    "gcc/cp/typeck2.c",
    "gcc/c-family/c-common.c",
    "gcc/c-family/c-common.h",
    "gcc/c-family/c-objc.h",
    "gcc/c-family/c-lex.c",
    "gcc/c-family/c-pragma.h",
    "gcc/c-family/c-pragma.c",
    "gcc/cp/class.c",
    "gcc/cp/cp-objcp-common.c",
    "gcc/cp/cp-lang.c",
    "gcc/cp/except.c",
    "[c]",
    "gcc/c-lang.c",
    "gcc/c-tree.h",
    "gcc/c-decl.c",
    "gcc/c-family/c-common.c",
    "gcc/c-family/c-common.h",
    "gcc/c-family/c-objc.h",
    "gcc/c-family/c-cppbuiltin.c",
    "gcc/c-family/c-pragma.h",
    "gcc/c-family/c-pragma.c",
    "gcc/c-objc-common.c",
    "gcc/c-parser.c",
    "gcc/c-lang.h",
]

write_file(
    name = "gtyp-input.list",
    content = "\n".join([path if path.startswith("[") else "source/" + path for path in GTYPE_INPUTS]) + "\n",
)

[
    generate(
        name = stage + "-gengtype-scanner",
        args = [
            "--noline",
            "-o",
            "gengtype-lex.c",
            "$(location :gcc-4.7.4[gcc/gengtype-lex.l])",
        ],
        chdir = "cellar//bootstrap/stage0-posix/cellar-extra:chdirenv",
        directory = True,
        files = ["gengtype-lex.c"],
        tool = "cellar//bootstrap/stage1/flex:flex",
    )
    for stage in STAGES
]

[
    filegroup(
        name = stage + "-gengtype-source",
        srcs = GCC_STAGE_SOURCES[stage] | {"gcc/gengtype-lex.c": ":" + stage + "-gengtype-scanner[gengtype-lex.c]"},
    )
    for stage in STAGES
]

GTYPE_OBJECTS = [
    "gengtype",
    "gengtype-lex",
    "gengtype-parse",
    "gengtype-state",
    "version",
]

VERSION_DEFINES = [
    'BASEVER="4.7.4"',
    'DATESTAMP=""',
    'DEVPHASE=""',
    'REVISION=""',
    'PKGVERSION="(Cellar bootstrap) "',
    'BUGURL="https://gcc.gnu.org/bugs/"',
]

[
    c_object(
        name = stage + "-" + name + ".o",
        src = ":" + stage + "-gengtype-source[gcc/" + name + ".c]",
        defines = GENERATOR_DEFINES + (VERSION_DEFINES if name == "version" else []),
        flags = [
            "-O2",
            "-Werror",
        ],
        logical_includes = GENERATOR_INCLUDES,
        logical_source = "gcc/" + name + ".c",
        object_name = name + ".o",
        source_alias = SOURCE_ALIAS,
        source_tree = ":" + stage + "-gengtype-source",
        toolchain = predecessor,
    )
    for stage, predecessor in STAGES.items()
    for name in GTYPE_OBJECTS
]

[
    c_binary(
        name = stage + "-gengtype",
        libraries = [":" + stage + "-libiberty.a"] + HOST_LIBC[stage],
        objects = HOST_CRT[stage] + [":" + stage + "-" + name + ".o" for name in GTYPE_OBJECTS + ["errors"]] + HOST_CRTN[stage],
        toolchain = predecessor,
    )
    for stage, predecessor in STAGES.items()
]

[
    filegroup(
        name = stage + "-gtype-inputs",
        srcs = GCC_STAGE_SOURCES[stage] | {"gcc/options.h": ":" + stage + "-options.h"},
    )
    for stage in STAGES
]

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
        source_tree = ":" + stage + "-gtype-inputs",
        tool = ":" + stage + "-gengtype",
    )
    for stage in STAGES
]

GTYPE_OUTPUTS = [
    "gt-alias.h",
    "gt-bitmap.h",
    "gt-c-decl.h",
    "gt-c-family-c-common.h",
    "gt-c-family-c-cppbuiltin.h",
    "gt-c-family-c-pragma.h",
    "gt-c-parser.h",
    "gt-caller-save.h",
    "gt-cfglayout.h",
    "gt-cgraph.h",
    "gt-cgraphunit.h",
    "gt-coverage.h",
    "gt-cp-call.h",
    "gt-cp-class.h",
    "gt-cp-cp-lang.h",
    "gt-cp-cp-objcp-common.h",
    "gt-cp-decl.h",
    "gt-cp-decl2.h",
    "gt-cp-except.h",
    "gt-cp-mangle.h",
    "gt-cp-method.h",
    "gt-cp-name-lookup.h",
    "gt-cp-parser.h",
    "gt-cp-pt.h",
    "gt-cp-repo.h",
    "gt-cp-rtti.h",
    "gt-cp-semantics.h",
    "gt-cp-tree.h",
    "gt-cp-typeck2.h",
    "gt-cselib.h",
    "gt-dbxout.h",
    "gt-dojump.h",
    "gt-dwarf2asm.h",
    "gt-dwarf2cfi.h",
    "gt-dwarf2out.h",
    "gt-emit-rtl.h",
    "gt-except.h",
    "gt-explow.h",
    "gt-expr.h",
    "gt-function.h",
    "gt-gcse.h",
    "gt-gimple.h",
    "gt-gimplify.h",
    "gt-godump.h",
    "gt-i386.h",
    "gt-integrate.h",
    "gt-lists.h",
    "gt-lto-symtab.h",
    "gt-omp-low.h",
    "gt-optabs.h",
    "gt-passes.h",
    "gt-sdbout.h",
    "gt-stor-layout.h",
    "gt-stringpool.h",
    "gt-targhooks.h",
    "gt-trans-mem.h",
    "gt-tree-iterator.h",
    "gt-tree-mudflap.h",
    "gt-tree-nested.h",
    "gt-tree-parloops.h",
    "gt-tree-phinodes.h",
    "gt-tree-profile.h",
    "gt-tree-scalar-evolution.h",
    "gt-tree-ssa-address.h",
    "gt-tree-ssa-propagate.h",
    "gt-tree-vect-generic.h",
    "gt-tree.h",
    "gt-varasm.h",
    "gt-varpool.h",
    "gtype-c.h",
    "gtype-cp.h",
    "gtype-desc.c",
    "gtype-desc.h",
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
        source_tree = ":" + stage + "-gtype-inputs",
        tool = ":" + stage + "-gengtype",
    )
    for stage in STAGES
]

c_object(
    name = "rtl-test.o",
    src = "tests/rtl.c",
    defines = GENERATOR_DEFINES,
    flags = [
        "-O2",
        "-Werror",
    ],
    # do not sort
    includes = [
        ":stage1-machine-generated",
        ":stage1-generator-source[gcc]",
        ":stage1-generator-source[include]",
        ":stage1-library-source[libcpp/include]",
    ],
    toolchain = PREDECESSOR,
)

c_binary(
    name = "rtl-test-bin",
    libraries = [":stage1-libiberty.a"] + LIBC,
    objects = CRT + [
        ":rtl-test.o",
        ":stage1-base-mode-object",
        ":stage1-read-md.o",
        ":stage1-errors.o",
    ] + [":stage1-" + name + ".o" for name in RTL_SUPPORT] + CRTN,
    toolchain = PREDECESSOR,
)

command_test(
    name = "native-rtl",
    args = ["$(location :stage1-insn-conditions.md)"],
    tool = ":rtl-test-bin",
)

write_file(
    name = "bad.md",
    content = "(define_constants [(1 missing_close]\n",
)

command_test(
    name = "machine-description-diagnostics",
    args = [
        "1",
        "$(exe :stage1-genconstants)",
        "$(location :bad.md)",
    ],
    tool = "cellar//bootstrap/stage1/tools:expect-exit",
)

[filegroup(
    name = stage + "-generated",
    srcs = {output: ":" + stage + "-" + output.replace("/", "-") for output, tool, args in BASE_GENERATED} | {output: ":" + stage + "-" + output for output, tool in MD_OUTPUTS} | {output: ":" + stage + "-" + output for output, tool, args in EARLY_MD_OUTPUTS} | {output: ":" + stage + "-" + output for output, script in OPTION_GENERATORS} | {output: ":" + stage + "-gtype-output[" + output + "]" for output in GTYPE_OUTPUTS} | {
        "insn-conditions.md": ":" + stage + "-insn-conditions.md",
        "gtype.state": ":" + stage + "-gtype-state[gtype.state]",
        "i386-builtin-types.inc": ":" + stage + "-i386-builtin-types.inc",
    },
) for stage in STAGES]

# The full native C/C++ compiler graph follows gcc/Makefile.in and cp/Make-lang.in.
write_file(
    name = "compiler-tm.h",
    content = '#ifndef GCC_TM_H\n#define GCC_TM_H 1\n#include "options.h"\n#include "insn-constants.h"\n#ifdef IN_GCC\n#include "config/i386/biarch64.h"\n#include "config/i386/i386.h"\n#include "config/linux-android.h"\n#include "config/i386/unix.h"\n#include "config/i386/att.h"\n#include "config/dbxelf.h"\n#include "config/elfos.h"\n#include "config/gnu-user.h"\n#include "config/glibc-stdint.h"\n#include "config/i386/x86-64.h"\n#include "config/i386/gnu-user64.h"\n#include "config/linux.h"\n#include "config/i386/linux64.h"\n#endif\n#if defined IN_GCC && !defined GENERATOR_FILE && !defined USED_FOR_TARGET\n#include "insn-flags.h"\n#endif\n#include "defaults.h"\n#undef TARGET_CAN_SPLIT_STACK\n#undef TARGET_THREAD_SPLIT_STACK_OFFSET\n#endif\n',
)

export_file(name = "patches/except-include.patch")

exact_patch(
    name = "except-include.c",
    src = ":gcc-4.7.4[gcc/cp/except.c]",
    output = "except-include.c",
    patch = ":patches/except-include.patch",
)

export_file(name = "patches/except-libfn.patch")

exact_patch(
    name = "except-libfn.c",
    src = ":except-include.c",
    output = "except-libfn.c",
    patch = ":patches/except-libfn.patch",
)

# c-common.h already declares this object extern. Its definition need not
# repeat the storage specifier, which warns in the C bootstrap with -Werror.
export_file(name = "patches/c-family-mask.patch")

exact_patch(
    name = "c-opts.c",
    src = ":gcc-4.7.4[gcc/c-family/c-opts.c]",
    patch = ":patches/c-family-mask.patch",
)

export_file(name = "patches/gcov-program.patch")

exact_patch(
    name = "gcov-program.c",
    src = ":gcc-4.7.4[gcc/gcov-iov.c]",
    output = "gcov-program.c",
    patch = ":patches/gcov-program.patch",
)

[
    filegroup(
        name = stage + "-compiler-generator-source",
        srcs = GCC_STAGE_SOURCES[stage] | {path: ":gcc-4.7.4[" + path + "]" for path in COMPILER_FILES} | {"gcc/gcov-iov.c": ":gcov-program.c"},
    )
    for stage in STAGES
]

[
    [
        c_object(
            name = stage + "-" + name + ".o",
            src = ":" + stage + "-compiler-generator-source[gcc/" + name + ".c]",
            defines = GENERATOR_DEFINES,
            flags = [
                "-O2",
                "-Werror",
            ],
            logical_includes = GENERATOR_INCLUDES,
            logical_source = "gcc/" + name + ".c",
            source_alias = SOURCE_ALIAS,
            source_tree = ":" + stage + "-compiler-generator-source",
            toolchain = predecessor,
        ),
        c_binary(
            name = stage + "-" + name,
            libraries = [":" + stage + "-libiberty.a"] + HOST_LIBC[stage],
            objects = HOST_CRT[stage] + [":" + stage + "-" + name + ".o"] + HOST_CRTN[stage],
            toolchain = predecessor,
        ),
    ]
    for stage, predecessor in STAGES.items()
    for name in [
        "genchecksum",
        "gcov-iov",
    ]
]

[generate(
    name = stage + "-gcov-iov.h",
    args = [
        "4.7.4",
        "",
    ],
    capture = CAPTURE,
    tool = ":" + stage + "-gcov-iov",
) for stage in STAGES]

[
    filegroup(
        name = stage + "-compiler-source",
        srcs = GCC_STAGE_SOURCES[stage] |
               {path: ":gcc-4.7.4[" + path + "]" for path in COMPILER_FILES} |
               {"gcc/" + output: ":" + stage + "-" + output.replace("/", "-") for output, tool, args in BASE_GENERATED} |
               {"gcc/" + output: ":" + stage + "-" + output for output, tool in MD_OUTPUTS} |
               {"gcc/" + output: ":" + stage + "-" + output for output, tool, args in EARLY_MD_OUTPUTS} |
               {"gcc/" + output: ":" + stage + "-" + output for output, script in OPTION_GENERATORS} |
               {"gcc/" + output: ":" + stage + "-gtype-output[" + output + "]" for output in GTYPE_OUTPUTS} | {
            "gcc/tm.h": ":compiler-tm.h",
            "gcc/cp/except.c": ":except-libfn.c",
            "gcc/c-family/c-opts.c": ":c-opts.c",
            "gcc/gcov-iov.h": ":" + stage + "-gcov-iov.h",
            "gcc/i386-builtin-types.inc": ":" + stage + "-i386-builtin-types.inc",
            "libdecnumber": ":" + stage + "-library-source[libdecnumber]",
            "gmp": "cellar//bootstrap/stage1/gmp:headers",
            "mpfr": "cellar//bootstrap/stage1/mpfr:headers",
            "mpc": "cellar//bootstrap/stage1/mpc:headers",
            "zlib": "cellar//bootstrap/stage1/binutils:zlib-source[zlib]",
        },
    )
    for stage in STAGES
]

BACKEND_OBJECTS = [
    "insn-attrtab",
    "insn-automata",
    "insn-emit",
    "insn-extract",
    "insn-modes",
    "insn-opinit",
    "insn-output",
    "insn-peep",
    "insn-preds",
    "insn-recog",
    "insn-enums",
    "ggc-page",
    "alias",
    "alloc-pool",
    "auto-inc-dec",
    "bb-reorder",
    "bitmap",
    "bt-load",
    "builtins",
    "caller-save",
    "calls",
    "cfg",
    "cfganal",
    "cfgbuild",
    "cfgcleanup",
    "cfgexpand",
    "cfghooks",
    "cfglayout",
    "cfgloop",
    "cfgloopanal",
    "cfgloopmanip",
    "cfgrtl",
    "cgraph",
    "cgraphbuild",
    "cgraphunit",
    "combine",
    "combine-stack-adj",
    "compare-elim",
    "convert",
    "coverage",
    "cppbuiltin",
    "cppdefault",
    "cprop",
    "cse",
    "cselib",
    "data-streamer",
    "data-streamer-in",
    "data-streamer-out",
    "dbxout",
    "dbgcnt",
    "dce",
    "ddg",
    "debug",
    "df-core",
    "df-problems",
    "df-scan",
    "dfp",
    "dojump",
    "dominance",
    "domwalk",
    "double-int",
    "dse",
    "dwarf2asm",
    "dwarf2cfi",
    "dwarf2out",
    "ebitmap",
    "emit-rtl",
    "et-forest",
    "except",
    "explow",
    "expmed",
    "expr",
    "final",
    "fixed-value",
    "fold-const",
    "function",
    "fwprop",
    "gcse",
    "ggc-common",
    "gimple",
    "gimple-iterator",
    "gimple-fold",
    "gimple-low",
    "gimple-pretty-print",
    "gimple-streamer-in",
    "gimple-streamer-out",
    "gimplify",
    "godump",
    "graph",
    "graphds",
    "graphite",
    "graphite-blocking",
    "graphite-clast-to-gimple",
    "graphite-cloog-util",
    "graphite-dependences",
    "graphite-flattening",
    "graphite-interchange",
    "graphite-poly",
    "graphite-ppl",
    "graphite-scop-detection",
    "graphite-sese-to-poly",
    "gtype-desc",
    "haifa-sched",
    "hw-doloop",
    "hwint",
    "ifcvt",
    "ree",
    "incpath",
    "init-regs",
    "integrate",
    "internal-fn",
    "ipa-cp",
    "ipa-split",
    "ipa-inline",
    "ipa-inline-analysis",
    "ipa-inline-transform",
    "ipa-prop",
    "ipa-pure-const",
    "ipa-reference",
    "ipa-ref",
    "ipa-utils",
    "ipa",
    "ira",
    "ira-build",
    "ira-costs",
    "ira-conflicts",
    "ira-color",
    "ira-emit",
    "ira-lives",
    "jump",
    "langhooks",
    "lcm",
    "lists",
    "loop-doloop",
    "loop-init",
    "loop-invariant",
    "loop-iv",
    "loop-unroll",
    "loop-unswitch",
    "lower-subreg",
    "lto-cgraph",
    "lto-streamer",
    "lto-streamer-in",
    "lto-streamer-out",
    "lto-section-in",
    "lto-section-out",
    "lto-symtab",
    "lto-opts",
    "lto-compress",
    "matrix-reorg",
    "mcf",
    "mode-switching",
    "modulo-sched",
    "omega",
    "omp-low",
    "optabs",
    "options-save",
    "opts-global",
    "passes",
    "plugin",
    "pointer-set",
    "postreload-gcse",
    "postreload",
    "predict",
    "print-rtl",
    "print-tree",
    "profile",
    "real",
    "realmpfr",
    "recog",
    "reg-stack",
    "regcprop",
    "reginfo",
    "regmove",
    "regrename",
    "regstat",
    "reload",
    "reload1",
    "reorg",
    "resource",
    "rtl-error",
    "rtl",
    "rtlanal",
    "rtlhooks",
    "sbitmap",
    "sched-deps",
    "sched-ebb",
    "sched-rgn",
    "sched-vis",
    "sdbout",
    "sel-sched-ir",
    "sel-sched-dump",
    "sel-sched",
    "sese",
    "simplify-rtx",
    "sparseset",
    "sreal",
    "stack-ptr-mod",
    "statistics",
    "stmt",
    "stor-layout",
    "store-motion",
    "streamer-hooks",
    "stringpool",
    "target-globals",
    "targhooks",
    "timevar",
    "toplev",
    "tracer",
    "trans-mem",
    "tree-affine",
    "tree-call-cdce",
    "tree-cfg",
    "tree-cfgcleanup",
    "tree-chrec",
    "tree-complex",
    "tree-data-ref",
    "tree-dfa",
    "tree-diagnostic",
    "tree-dump",
    "tree-eh",
    "tree-emutls",
    "tree-if-conv",
    "tree-inline",
    "tree-into-ssa",
    "tree-iterator",
    "tree-loop-distribution",
    "tree-nested",
    "tree-nomudflap",
    "tree-nrv",
    "tree-object-size",
    "tree-optimize",
    "tree-outof-ssa",
    "tree-parloops",
    "tree-phinodes",
    "tree-predcom",
    "tree-pretty-print",
    "tree-profile",
    "tree-scalar-evolution",
    "tree-sra",
    "tree-switch-conversion",
    "tree-ssa-address",
    "tree-ssa-alias",
    "tree-ssa-ccp",
    "tree-ssa-coalesce",
    "tree-ssa-copy",
    "tree-ssa-copyrename",
    "tree-ssa-dce",
    "tree-ssa-dom",
    "tree-ssa-dse",
    "tree-ssa-forwprop",
    "tree-ssa-ifcombine",
    "tree-ssa-live",
    "tree-ssa-loop-ch",
    "tree-ssa-loop-im",
    "tree-ssa-loop-ivcanon",
    "tree-ssa-loop-ivopts",
    "tree-ssa-loop-manip",
    "tree-ssa-loop-niter",
    "tree-ssa-loop-prefetch",
    "tree-ssa-loop-unswitch",
    "tree-ssa-loop",
    "tree-ssa-math-opts",
    "tree-ssa-operands",
    "tree-ssa-phiopt",
    "tree-ssa-phiprop",
    "tree-ssa-pre",
    "tree-ssa-propagate",
    "tree-ssa-reassoc",
    "tree-ssa-sccvn",
    "tree-ssa-sink",
    "tree-ssa-strlen",
    "tree-ssa-structalias",
    "tree-ssa-tail-merge",
    "tree-ssa-ter",
    "tree-ssa-threadedge",
    "tree-ssa-threadupdate",
    "tree-ssa-uncprop",
    "tree-ssa-uninit",
    "tree-ssa",
    "tree-ssanames",
    "tree-stdarg",
    "tree-streamer",
    "tree-streamer-in",
    "tree-streamer-out",
    "tree-tailcall",
    "tree-vect-generic",
    "tree-vect-patterns",
    "tree-vect-data-refs",
    "tree-vect-stmts",
    "tree-vect-loop",
    "tree-vect-loop-manip",
    "tree-vect-slp",
    "tree-vectorizer",
    "tree-vrp",
    "tree",
    "value-prof",
    "var-tracking",
    "varasm",
    "varpool",
    "vmsdbgout",
    "web",
    "xcoffout",
    "config/i386/i386",
    "config/host-linux",
]

C_OBJECTS = [
    "c-lang",
    "c-family/stub-objc",
    "attribs",
    "c-errors",
    "c-decl",
    "c-typeck",
    "c-convert",
    "c-aux-info",
    "c-objc-common",
    "c-parser",
    "tree-mudflap",
    "c-family/c-common",
    "c-family/c-cppbuiltin",
    "c-family/c-dump",
    "c-family/c-format",
    "c-family/c-gimplify",
    "c-family/c-lex",
    "c-family/c-omp",
    "c-family/c-opts",
    "c-family/c-pch",
    "c-family/c-ppoutput",
    "c-family/c-pragma",
    "c-family/c-pretty-print",
    "c-family/c-semantics",
    "c-family/c-ada-spec",
    "config/i386/i386-c",
    "config/default-c",
]

CXX_OBJECTS = [
    "cp/cp-lang",
    "c-family/stub-objc",
    "cp/call",
    "cp/decl",
    "cp/expr",
    "cp/pt",
    "cp/typeck2",
    "cp/class",
    "cp/decl2",
    "cp/error",
    "cp/lex",
    "cp/parser",
    "cp/ptree",
    "cp/rtti",
    "cp/typeck",
    "cp/cvt",
    "cp/except",
    "cp/friend",
    "cp/init",
    "cp/method",
    "cp/search",
    "cp/semantics",
    "cp/tree",
    "cp/repo",
    "cp/dump",
    "cp/optimize",
    "cp/mangle",
    "cp/cp-objcp-common",
    "cp/name-lookup",
    "cp/cxx-pretty-print",
    "cp/cp-gimplify",
    "tree-mudflap",
    "attribs",
    "incpath",
    "c-family/c-common",
    "c-family/c-cppbuiltin",
    "c-family/c-dump",
    "c-family/c-format",
    "c-family/c-gimplify",
    "c-family/c-lex",
    "c-family/c-omp",
    "c-family/c-opts",
    "c-family/c-pch",
    "c-family/c-ppoutput",
    "c-family/c-pragma",
    "c-family/c-pretty-print",
    "c-family/c-semantics",
    "c-family/c-ada-spec",
    "config/i386/i386-c",
    "config/default-c",
]

COMMON_OBJECTS = [
    "diagnostic",
    "pretty-print",
    "intl",
    "input",
    "version",
]

COMMON_TARGET_OBJECTS = [
    "common/config/i386/i386-common",
    "prefix",
    "params",
    "opts",
    "opts-common",
    "options",
    "vec",
    "hooks",
    "common/common-targhooks",
]

COMPILER_OBJECTS = {name: "gcc/" + name + ".c" for name in BACKEND_OBJECTS + C_OBJECTS + CXX_OBJECTS + COMMON_OBJECTS + COMMON_TARGET_OBJECTS + ["main"]}

COMPILER_DEFINES = [
    "_GNU_SOURCE=1",
    "IN_GCC=1",
    "HAVE_CONFIG_H=1",
    'TARGET_NAME="x86_64-cellar-linux-musl"',
    'TARGET_MACHINE="x86_64-cellar-linux-musl"',
    'HOST_MACHINE="x86_64-cellar-linux-musl"',
    'PREFIX="/nonexistent-bootstrap-gcc"',
    'LOCALEDIR="/nonexistent-bootstrap-locale"',
    'GCC_INCLUDE_DIR="/nonexistent-bootstrap-gcc/include"',
    'STANDARD_EXEC_PREFIX="/nonexistent-bootstrap-gcc/lib/gcc/"',
    'NATIVE_SYSTEM_HEADER_DIR="/include"',
    'GPLUSPLUS_INCLUDE_DIR="/include/c++/4.7.4"',
    'GPLUSPLUS_TOOL_INCLUDE_DIR="/include/c++/4.7.4/x86_64-cellar-linux-musl"',
    'GPLUSPLUS_BACKWARD_INCLUDE_DIR="/include/c++/4.7.4/backward"',
    "GPLUSPLUS_INCLUDE_DIR_ADD_SYSROOT=1",
]

COMPILER_INCLUDES = GENERATOR_INCLUDES + [
    "gcc/cp",
    "gcc/c-family",
    "libdecnumber",
    "libdecnumber/bid",
    "gmp",
    "mpfr",
    "mpc",
    "zlib",
]

[
    c_object(
        name = stage + "-cc-" + name.replace("/", "-") + ".o",
        src = ":" + stage + "-compiler-source[" + source + "]",
        defines = COMPILER_DEFINES + (VERSION_DEFINES if name == "version" else ['BASEVER="4.7.4"'] if name in [
            "prefix",
            "cppbuiltin",
        ] else []) + (["IN_GCC_FRONTEND=1"] if name in C_OBJECTS + CXX_OBJECTS else []),
        # Upstream stage1 accepts older host compilers' diagnostic extensions.
        flags = ["-O2"] + ([] if stage == "stage1" else ["-Werror"]),
        logical_includes = COMPILER_INCLUDES,
        logical_source = source,
        object_name = "cc" + str(i) + ".o",
        source_alias = SOURCE_ALIAS,
        source_tree = ":" + stage + "-compiler-source",
        toolchain = predecessor,
    )
    for stage, predecessor in STAGES.items()
    for i, (name, source) in enumerate(COMPILER_OBJECTS.items())
]

[
    c_library(
        name = stage + "-" + library + ".a",
        objects = [":" + stage + "-cc-" + name.replace("/", "-") + ".o" for name in objects],
        output = library + ".a",
        toolchain = predecessor,
    )
    for stage, predecessor in STAGES.items()
    for library, objects in [
        ("libbackend", BACKEND_OBJECTS),
        ("libcommon", COMMON_OBJECTS),
        ("libcommon-target", COMMON_TARGET_OBJECTS),
    ]
]

# Recompile the already source-regenerated binutils zlib dependency each stage.
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
        toolchain = predecessor,
    )
    for stage, predecessor in STAGES.items()
    for i, name in enumerate(ZLIB_OBJECTS)
]

[c_library(
    name = stage + "-libz.a",
    objects = [":" + stage + "-zlib-" + name + ".o" for name in ZLIB_OBJECTS],
    output = "libz.a",
    toolchain = predecessor,
) for stage, predecessor in STAGES.items()]

COMPILER_LIBRARIES = {stage: [":" + stage + "-" + name + ".a" for name in [
    "libbackend",
    "libcommon-target",
    "libcommon",
    "libcpp",
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
            args = ["$(location :" + stage + "-cc-" + name.replace("/", "-") + ".o)" for name in objects + ["main"]] +
                   ["$(location " + library + ")" for library in COMPILER_LIBRARIES[stage]] + ["$(location :checksum-options)"],
            capture = CAPTURE,
            output = frontend + "-checksum.c",
            tool = ":" + stage + "-genchecksum",
        ),
        filegroup(
            name = stage + "-" + frontend + "-checksum-source",
            srcs = {
                "checksum.c": ":" + stage + "-" + frontend + "-checksum.c",
                "gcc": ":" + stage + "-compiler-source[gcc]",
                "include": ":" + stage + "-library-source[include]",
            },
        ),
        c_object(
            name = stage + "-" + frontend + "-checksum.o",
            src = ":" + stage + "-" + frontend + "-checksum.c",
            defines = COMPILER_DEFINES,
            flags = [
                "-O2",
                "-Werror",
            ],
            logical_includes = [
                "gcc",
                "include",
            ],
            logical_source = "checksum.c",
            source_alias = SOURCE_ALIAS,
            source_tree = ":" + stage + "-" + frontend + "-checksum-source",
            toolchain = predecessor,
        ),
        c_binary(
            name = stage + "-" + frontend,
            libraries = COMPILER_LIBRARIES[stage] + HOST_LIBC[stage],
            objects = HOST_CRT[stage] + [":" + stage + "-cc-" + name.replace("/", "-") + ".o" for name in objects + ["main"]] + [":" + stage + "-" + frontend + "-checksum.o"] + HOST_CRTN[stage],
            output = frontend,
            toolchain = predecessor,
        ),
    ]
    for stage, predecessor in STAGES.items()
    for frontend, objects in [
        ("cc1", C_OBJECTS),
        ("cc1plus", CXX_OBJECTS),
    ]
]

[filegroup(
    name = stage + "-compilers",
    srcs = {name: ":" + stage + "-" + name for name in [
        "cc1",
        "cc1plus",
    ]},
) for stage in STAGES]

# Front-end acceptance precedes target runtime installation. These programs use
# the existing static C runtime; C++ exceptions/RTTI/STL follow with libstdc++.
[
    [
        generate(
            name = "frontend-" + name + "-" + opt + ".s",
            args = [
                "-quiet",
                "-nostdinc",
                "-isystem",
                "$(location " + MUSL + ":headers)",
                "-" + opt,
                "-frandom-seed=bootstrap",
            ] + extra + [
                "$(location " + source + ")",
                "-o",
            ],
            output = "program.s",
            tool = ":stage1-" + frontend,
        ),
        generate(
            name = "frontend-" + name + "-" + opt + "-asm",
            args = [
                "--64",
                "$(location :frontend-" + name + "-" + opt + ".s)",
                "-o",
            ],
            output = "program.o",
            tool = "cellar//bootstrap/stage1/binutils:as",
        ),
        bootstrap_artifact(
            name = "frontend-" + name + "-" + opt + ".o",
            src = ":frontend-" + name + "-" + opt + "-asm",
            abi = "x86_64-sysv",
            kind = "object",
            object_format = "elf64-x86-64",
        ),
        c_binary(
            name = "frontend-" + name + "-" + opt + "-bin",
            libraries = LIBC,
            objects = CRT + [":frontend-" + name + "-" + opt + ".o"] + CRTN,
            toolchain = PREDECESSOR,
        ),
        command_test(
            name = "frontend-" + name + "-" + opt,
            args = [
                "startup",
                "ok",
            ] if name == "runtime" else [],
            env = {"BOOTSTRAP_TEST": "present"},
            tool = ":frontend-" + name + "-" + opt + "-bin",
        ),
    ]
    for opt in [
        "O0",
        "O2",
    ]
    for name, frontend, source, extra in [
        (
            "c-language",
            "cc1",
            "cellar//bootstrap/stage1/gcc40:tests/c-language.c",
            ["-std=gnu99"],
        ),
        (
            "cxx-language",
            "cc1plus",
            ":tests/cxx-language.cc",
            [
                "-std=gnu++11",
                "-fno-exceptions",
                "-fno-rtti",
            ],
        ),
        ("runtime", "cc1", "cellar//bootstrap/stage1/musl:test-source[tests/runtime.c]", []),
        ("threads", "cc1", "cellar//bootstrap/stage1/musl:test-source[tests/threads.c]", []),
        ("native-math", "cc1", "cellar//bootstrap/stage1/musl:test-source[tests/native-math.c]", []),
        ("unicode", "cc1", "cellar//bootstrap/stage1/musl:test-source[tests/unicode.c]", []),
    ]
]

export_file(name = "tests/cxx-language.cc")

write_file(
    name = "invalid.c",
    content = "int main(void) { return undeclared; }\n",
)

write_file(
    name = "invalid.cc",
    content = "template<class T> struct A { typedef typename T::missing type; }; A<int>::type value;\n",
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
        tool = "cellar//bootstrap/stage1/tools:expect-exit",
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
    tool = "cellar//bootstrap/stage1/tools:expect-exit",
)

export_file(name = "patches/driver-tool.patch")

exact_patch(
    name = "driver-tool.c",
    src = ":gcc-4.7.4[gcc/gcc.c]",
    output = "gcc.c",
    patch = ":patches/driver-tool.patch",
)

export_file(name = "patches/driver-pipe.patch")

exact_patch(
    name = "driver-pipe.c",
    src = ":driver-tool.c",
    output = "gcc.c",
    patch = ":patches/driver-pipe.patch",
)

write_file(
    name = "driver-tm.h",
    content = '#include "../compiler/gcc/tm.h"\n#undef LINK_SPEC\n#define LINK_SPEC "-m elf_x86_64 -static %{m32|mx32:%eOnly native x86_64 is supported} %{shared|pie:%eOnly static executables are supported}"\n#undef STARTFILE_SPEC\n#define STARTFILE_SPEC "crt1.o%s crti.o%s crtbeginT.o%s"\n#undef ENDFILE_SPEC\n#define ENDFILE_SPEC "%{Ofast|ffast-math|funsafe-math-optimizations:crtfastmath.o%s} %{mpc32:crtprec32.o%s} %{mpc64:crtprec64.o%s} %{mpc80:crtprec80.o%s} crtend.o%s crtn.o%s"\n#undef LIB_SPEC\n#define LIB_SPEC "-lc"\n#undef LINK_GCC_C_SEQUENCE_SPEC\n#define LINK_GCC_C_SEQUENCE_SPEC "--start-group %G %L --end-group"\n#undef LINK_EH_SPEC\n#define LINK_EH_SPEC ""\n',
)

write_file(
    name = "configargs.h",
    content = "static const char configuration_arguments[] = \"cellar Buck2 native x86_64, C/C++, static, no multilib/LTO/plugins/Graphite\";\nstatic const char thread_model[] = \"posix\";\nstatic const struct { const char *name, *value; } configure_default_options[] = {{0, 0}};\n",
)

write_file(
    name = "multilib.h",
    content = "static const char *const multilib_raw[] = {\". ;\", 0};\nstatic const char *const multilib_matches_raw[] = {0};\nstatic const char *const multilib_exclusions_raw[] = {0};\nstatic const char *multilib_extra = \"\";\nstatic const char *multilib_options = \"\";\nstatic const char *const multilib_reuse_raw[] = {0};\n#define DISABLE_MULTILIB 1\n",
)

write_file(
    name = "specs.h",
    content = '#include "cp/lang-specs.h"\n',
)

DRIVER_OBJECTS = {
    "gcc": "gcc.c",
    "gccspec": "gccspec.c",
    "cppspec": "cppspec.c",
    "g++spec": "cp/g++spec.c",
    "ggc-none": "ggc-none.c",
    "driver-i386": "config/i386/driver-i386.c",
    "gcov": "gcov.c",
    "gcov-dump": "gcov-dump.c",
}

[
    filegroup(
        name = stage + "-driver-source",
        srcs = {"compiler": ":" + stage + "-compiler-source"} |
               {"driver/" + source: ":gcc-4.7.4[gcc/" + source + "]" for source in DRIVER_OBJECTS.values()} | {
            "driver/gcc.c": ":driver-pipe.c",
            "driver/cp/lang-specs.h": ":gcc-4.7.4[gcc/cp/lang-specs.h]",
            "driver/config/i386/cpuid.h": ":gcc-4.7.4[gcc/config/i386/cpuid.h]",
            "driver/tm.h": ":driver-tm.h",
            "driver/configargs.h": ":configargs.h",
            "driver/multilib.h": ":multilib.h",
            "driver/specs.h": ":specs.h",
        },
    )
    for stage in STAGES
]

DRIVER_DEFINES = COMPILER_DEFINES + [
    "HAVE_GNU_LD=1",
    'LD_STATIC_OPTION="-Bstatic"',
    'LD_DYNAMIC_OPTION="-Bdynamic"',
    'STANDARD_STARTFILE_PREFIX="/lib/"',
    'STANDARD_STARTFILE_PREFIX_1=""',
    'STANDARD_STARTFILE_PREFIX_2=""',
    'STANDARD_LIBEXEC_PREFIX="/nonexistent-bootstrap-gcc/libexec/gcc/"',
    'STANDARD_BINDIR_PREFIX="/nonexistent-bootstrap-gcc/bin/"',
    'TOOLDIR_BASE_PREFIX="../../../"',
    'DEFAULT_TARGET_VERSION="4.7.4"',
    'DEFAULT_TARGET_MACHINE="x86_64-cellar-linux-musl"',
    'CONFIGURE_SPECS=""',
]

[
    c_object(
        name = stage + "-driver-" + name + ".o",
        src = ":" + stage + "-driver-source[driver/" + source + "]",
        defines = DRIVER_DEFINES,
        flags = ["-O2"] + ([] if stage == "stage1" else ["-Werror"]),
        logical_includes = ["driver"] + ["compiler/" + path for path in COMPILER_INCLUDES],
        logical_source = "driver/" + source,
        object_name = "driver" + str(i) + ".o",
        source_alias = SOURCE_ALIAS,
        source_tree = ":" + stage + "-driver-source",
        toolchain = predecessor,
    )
    for stage, predecessor in STAGES.items()
    for i, (name, source) in enumerate(DRIVER_OBJECTS.items())
]

[
    c_binary(
        name = stage + "-" + program,
        libraries = [":" + stage + "-" + name + ".a" for name in [
            "libcommon-target",
            "libcommon",
            "libcpp",
            "libiberty",
        ]] + HOST_LIBC[stage],
        objects = HOST_CRT[stage] + [":" + stage + "-driver-" + name + ".o" for name in objects] + HOST_CRTN[stage],
        output = program,
        toolchain = predecessor,
    )
    for stage, predecessor in STAGES.items()
    for program, objects in [
        (
            "xgcc",
            [
                "gcc",
                "ggc-none",
                "driver-i386",
                "gccspec",
            ],
        ),
        (
            "g++",
            [
                "gcc",
                "ggc-none",
                "driver-i386",
                "g++spec",
            ],
        ),
        (
            "cpp",
            [
                "gcc",
                "ggc-none",
                "driver-i386",
                "cppspec",
            ],
        ),
        (
            "gcov",
            ["gcov"],
        ),
        (
            "gcov-dump",
            ["gcov-dump"],
        ),
    ]
]

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

COMPILER_HEADERS = [
    "float.h",
    "iso646.h",
    "stdarg.h",
    "stdbool.h",
    "stddef.h",
    "varargs.h",
    "stdalign.h",
    "stdnoreturn.h",
    "stdfix.h",
    "stdint-gcc.h",
]

INTRINSIC_HEADERS = [
    "ammintrin.h",
    "avx2intrin.h",
    "avxintrin.h",
    "bmi2intrin.h",
    "bmiintrin.h",
    "bmmintrin.h",
    "emmintrin.h",
    "f16cintrin.h",
    "fma4intrin.h",
    "fmaintrin.h",
    "ia32intrin.h",
    "immintrin.h",
    "lwpintrin.h",
    "lzcntintrin.h",
    "mmintrin.h",
    "nmmintrin.h",
    "pmmintrin.h",
    "popcntintrin.h",
    "smmintrin.h",
    "tbmintrin.h",
    "tmmintrin.h",
    "wmmintrin.h",
    "x86intrin.h",
    "xmmintrin.h",
    "xopintrin.h",
    "cpuid.h",
]

filegroup(
    name = "compiler-headers",
    srcs = {name: ":gcc-4.7.4[gcc/ginclude/" + name + "]" for name in COMPILER_HEADERS} |
           {name: ":gcc-4.7.4[gcc/config/i386/" + name + "]" for name in INTRINSIC_HEADERS} | {
        "stdint.h": ":gcc-4.7.4[gcc/ginclude/stdint-wrap.h]",
        "mm_malloc.h": ":gcc-4.7.4[gcc/config/i386/pmm_malloc.h]",
        "unwind.h": ":gcc-4.7.4[libgcc/unwind-generic.h]",
    },
)

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
            stage = "gcc-4.7.4-" + stage,
            sysroot = MUSL + ":runtime",
            target_compatible_with = [
                "cellar//bootstrap/platforms:linux",
                "cellar//bootstrap/platforms:amd64",
            ],
        ),
    ]
    for stage in STAGES
]

[
    [
        c_object(
            name = "driver-test-" + name + ".o",
            src = source,
            flags = flags,
            toolchain = ":stage1-bootstrap-gcc",
        ),
        c_binary(
            name = "driver-test-" + name + "-bin",
            libraries = LIBC,
            objects = CRT + [":driver-test-" + name + ".o"] + CRTN,
            toolchain = PREDECESSOR,
        ),
        command_test(
            name = "driver-compile-" + name,
            tool = ":driver-test-" + name + "-bin",
        ),
    ]
    for name, source, flags in [
        (
            "c",
            "cellar//bootstrap/stage1/gcc40:tests/c-language.c",
            ["-O2"],
        ),
        (
            "pipe",
            "cellar//bootstrap/stage1/gcc40:tests/c-language.c",
            [
                "-O2",
                "-pipe",
            ],
        ),
        (
            "cxx",
            ":tests/cxx-language.cc",
            [
                "-O2",
                "-std=gnu++11",
                "-fno-exceptions",
                "-fno-rtti",
            ],
        ),
    ]
]

write_file(
    name = "tiny.c",
    content = "int main(void) { return 0; }\n",
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
    tool = "cellar//bootstrap/stage1/tools:expect-exit",
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
    tool = "cellar//bootstrap/stage1/tools:expect-exit",
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

[filegroup(
    name = stage + "-drivers",
    srcs = {name: ":" + stage + "-" + name for name in [
        "xgcc",
        "g++",
        "cpp",
        "gcov",
        "gcov-dump",
    ]},
) for stage in STAGES]

export_file(name = "patches/runtime-eh.patch")

exact_patch(
    name = "runtime-eh",
    src = ":gcc-4.7.4[libgcc/unwind-dw2-fde-dip.c]",
    patch = ":patches/runtime-eh.patch",
)

export_file(name = "patches/runtime-context.patch")

exact_patch(
    name = "runtime-context",
    src = ":gcc-4.7.4[libgcc/config/i386/linux-unwind.h]",
    patch = ":patches/runtime-context.patch",
)

# The target runtime is compiled by the newly built GCC, not its predecessor.
write_file(
    name = "tconfig.h",
    content = '#ifndef GCC_TCONFIG_H\n#define GCC_TCONFIG_H 1\n#define USED_FOR_TARGET 1\n#include "auto-host.h"\n#include "ansidecl.h"\n#endif\n',
)

write_file(
    name = "libgcc_tm.h",
    content = '#ifndef GCC_LIBGCC_TM_H\n#define GCC_LIBGCC_TM_H 1\n#include "config/i386/value-unwind.h"\n#endif\n',
)

[
    filegroup(
        name = stage + "-runtime-source",
        srcs = {"compiler": ":" + stage + "-compiler-source"} |
               {path: ":gcc-4.7.4[" + path + "]" for path in RUNTIME_FILES} | {
            "libgcc/unwind-dw2-fde-dip.c": ":runtime-eh",
            "libgcc/config/i386/linux-unwind.h": ":runtime-context",
            "libgcc/md-unwind-support.h": ":runtime-context",
            "libgcc/tconfig.h": ":tconfig.h",
            "libgcc/libgcc_tm.h": ":libgcc_tm.h",
            "libgcc/unwind.h": ":gcc-4.7.4[libgcc/unwind-generic.h]",
            "libgcc/gthr-default.h": ":gcc-4.7.4[libgcc/gthr-posix.h]",
            "libgcc/sfp-machine.h": ":gcc-4.7.4[libgcc/config/i386/sfp-machine.h]",
        },
    )
    for stage in STAGES
]

LIBGCC_FUNCTIONS = [
    "_muldi3",
    "_negdi2",
    "_lshrdi3",
    "_ashldi3",
    "_ashrdi3",
    "_cmpdi2",
    "_ucmpdi2",
    "_clear_cache",
    "_trampoline",
    "__main",
    "_absvsi2",
    "_absvdi2",
    "_addvsi3",
    "_addvdi3",
    "_subvsi3",
    "_subvdi3",
    "_mulvsi3",
    "_mulvdi3",
    "_negvsi2",
    "_negvdi2",
    "_ctors",
    "_ffssi2",
    "_ffsdi2",
    "_clz",
    "_clzsi2",
    "_clzdi2",
    "_ctzsi2",
    "_ctzdi2",
    "_popcount_tab",
    "_popcountsi2",
    "_popcountdi2",
    "_paritysi2",
    "_paritydi2",
    "_powisf2",
    "_powidf2",
    "_powixf2",
    "_mulsc3",
    "_muldc3",
    "_mulxc3",
    "_divsc3",
    "_divdc3",
    "_divxc3",
    "_bswapsi2",
    "_bswapdi2",
    "_clrsbsi2",
    "_clrsbdi2",
    "_fixunssfsi",
    "_fixunsdfsi",
    "_fixunsxfsi",
    "_fixsfdi",
    "_fixdfdi",
    "_fixxfdi",
    "_fixunssfdi",
    "_fixunsdfdi",
    "_fixunsxfdi",
    "_floatdisf",
    "_floatdidf",
    "_floatdixf",
    "_floatundisf",
    "_floatundidf",
    "_floatundixf",
    "_eprintf",
    "__gcc_bcmp",
]

LIBGCC_DIVMOD = [
    "_divdi3",
    "_moddi3",
    "_udivdi3",
    "_umoddi3",
    "_udiv_w_sdiv",
    "_udivmoddi4",
]

LIBGCOV_FUNCTIONS = [
    "_gcov",
    "_gcov_merge_add",
    "_gcov_merge_single",
    "_gcov_merge_delta",
    "_gcov_fork",
    "_gcov_execl",
    "_gcov_execlp",
    "_gcov_execle",
    "_gcov_execv",
    "_gcov_execvp",
    "_gcov_execve",
    "_gcov_interval_profiler",
    "_gcov_pow2_profiler",
    "_gcov_one_value_profiler",
    "_gcov_indirect_call_profiler",
    "_gcov_average_profiler",
    "_gcov_ior_profiler",
    "_gcov_merge_ior",
]

RUNTIME_OBJECTS = {
    "unwind-dw2": "libgcc/unwind-dw2.c",
    "unwind-dw2-fde-dip": "libgcc/unwind-dw2-fde-dip.c",
    "unwind-sjlj": "libgcc/unwind-sjlj.c",
    "unwind-c": "libgcc/unwind-c.c",
    "emutls": "libgcc/emutls.c",
    "enable-execute-stack-empty": "libgcc/enable-execute-stack-empty.c",
    "addtf3": "libgcc/soft-fp/addtf3.c",
    "divtf3": "libgcc/soft-fp/divtf3.c",
    "eqtf2": "libgcc/config/i386/64/eqtf2.c",
    "getf2": "libgcc/config/i386/64/getf2.c",
    "letf2": "libgcc/config/i386/64/letf2.c",
    "multf3": "libgcc/soft-fp/multf3.c",
    "negtf2": "libgcc/soft-fp/negtf2.c",
    "subtf3": "libgcc/soft-fp/subtf3.c",
    "unordtf2": "libgcc/soft-fp/unordtf2.c",
    "fixtfsi": "libgcc/soft-fp/fixtfsi.c",
    "fixunstfsi": "libgcc/soft-fp/fixunstfsi.c",
    "fixtfdi": "libgcc/soft-fp/fixtfdi.c",
    "fixunstfdi": "libgcc/soft-fp/fixunstfdi.c",
    "fixtfti": "libgcc/soft-fp/fixtfti.c",
    "fixunstfti": "libgcc/soft-fp/fixunstfti.c",
    "floatsitf": "libgcc/soft-fp/floatsitf.c",
    "floatunsitf": "libgcc/soft-fp/floatunsitf.c",
    "floatditf": "libgcc/soft-fp/floatditf.c",
    "floatunditf": "libgcc/soft-fp/floatunditf.c",
    "floattitf": "libgcc/soft-fp/floattitf.c",
    "floatuntitf": "libgcc/soft-fp/floatuntitf.c",
    "extendsftf2": "libgcc/soft-fp/extendsftf2.c",
    "extenddftf2": "libgcc/soft-fp/extenddftf2.c",
    "extendxftf2": "libgcc/soft-fp/extendxftf2.c",
    "trunctfsf2": "libgcc/soft-fp/trunctfsf2.c",
    "trunctfdf2": "libgcc/soft-fp/trunctfdf2.c",
    "trunctfxf2": "libgcc/soft-fp/trunctfxf2.c",
    "_divtc3": "libgcc/config/i386/64/_divtc3.c",
    "_multc3": "libgcc/config/i386/64/_multc3.c",
    "_powitf2": "libgcc/config/i386/64/_powitf2.c",
    "bid_decimal_globals": "libgcc/config/libbid/bid_decimal_globals.c",
    "bid_decimal_data": "libgcc/config/libbid/bid_decimal_data.c",
    "bid_binarydecimal": "libgcc/config/libbid/bid_binarydecimal.c",
    "bid_convert_data": "libgcc/config/libbid/bid_convert_data.c",
    "_isinfd32": "libgcc/config/libbid/_isinfd32.c",
    "_isinfd64": "libgcc/config/libbid/_isinfd64.c",
    "_isinfd128": "libgcc/config/libbid/_isinfd128.c",
    "bid64_noncomp": "libgcc/config/libbid/bid64_noncomp.c",
    "bid128_noncomp": "libgcc/config/libbid/bid128_noncomp.c",
    "bid128_fma": "libgcc/config/libbid/bid128_fma.c",
    "bid_round": "libgcc/config/libbid/bid_round.c",
    "bid_from_int": "libgcc/config/libbid/bid_from_int.c",
    "bid64_add": "libgcc/config/libbid/bid64_add.c",
    "bid128_add": "libgcc/config/libbid/bid128_add.c",
    "bid64_div": "libgcc/config/libbid/bid64_div.c",
    "bid128_div": "libgcc/config/libbid/bid128_div.c",
    "bid64_mul": "libgcc/config/libbid/bid64_mul.c",
    "bid128_mul": "libgcc/config/libbid/bid128_mul.c",
    "bid64_compare": "libgcc/config/libbid/bid64_compare.c",
    "bid128_compare": "libgcc/config/libbid/bid128_compare.c",
    "bid128": "libgcc/config/libbid/bid128.c",
    "bid32_to_bid64": "libgcc/config/libbid/bid32_to_bid64.c",
    "bid32_to_bid128": "libgcc/config/libbid/bid32_to_bid128.c",
    "bid64_to_bid128": "libgcc/config/libbid/bid64_to_bid128.c",
    "bid64_to_int32": "libgcc/config/libbid/bid64_to_int32.c",
    "bid64_to_int64": "libgcc/config/libbid/bid64_to_int64.c",
    "bid64_to_uint32": "libgcc/config/libbid/bid64_to_uint32.c",
    "bid64_to_uint64": "libgcc/config/libbid/bid64_to_uint64.c",
    "bid128_to_int32": "libgcc/config/libbid/bid128_to_int32.c",
    "bid128_to_int64": "libgcc/config/libbid/bid128_to_int64.c",
    "bid128_to_uint32": "libgcc/config/libbid/bid128_to_uint32.c",
    "bid128_to_uint64": "libgcc/config/libbid/bid128_to_uint64.c",
}

DFP_OBJECTS = {
    "32": [
        "_addsub_sd",
        "_div_sd",
        "_mul_sd",
        "_eq_sd",
        "_ne_sd",
        "_lt_sd",
        "_gt_sd",
        "_le_sd",
        "_ge_sd",
        "_sd_to_si",
        "_sd_to_di",
        "_sd_to_usi",
        "_sd_to_udi",
        "_si_to_sd",
        "_di_to_sd",
        "_usi_to_sd",
        "_udi_to_sd",
        "_sd_to_sf",
        "_sd_to_df",
        "_sd_to_xf",
        "_sd_to_tf",
        "_sf_to_sd",
        "_df_to_sd",
        "_xf_to_sd",
        "_tf_to_sd",
        "_sd_to_dd",
        "_sd_to_td",
        "_unord_sd",
    ],
    "64": [
        "_addsub_dd",
        "_div_dd",
        "_mul_dd",
        "_eq_dd",
        "_ne_dd",
        "_lt_dd",
        "_gt_dd",
        "_le_dd",
        "_ge_dd",
        "_dd_to_si",
        "_dd_to_di",
        "_dd_to_usi",
        "_dd_to_udi",
        "_si_to_dd",
        "_di_to_dd",
        "_usi_to_dd",
        "_udi_to_dd",
        "_dd_to_sf",
        "_dd_to_df",
        "_dd_to_xf",
        "_dd_to_tf",
        "_sf_to_dd",
        "_df_to_dd",
        "_xf_to_dd",
        "_tf_to_dd",
        "_dd_to_sd",
        "_dd_to_td",
        "_unord_dd",
    ],
    "128": [
        "_addsub_td",
        "_div_td",
        "_mul_td",
        "_eq_td",
        "_ne_td",
        "_lt_td",
        "_gt_td",
        "_le_td",
        "_ge_td",
        "_td_to_si",
        "_td_to_di",
        "_td_to_usi",
        "_td_to_udi",
        "_si_to_td",
        "_di_to_td",
        "_usi_to_td",
        "_udi_to_td",
        "_td_to_sf",
        "_td_to_df",
        "_td_to_xf",
        "_td_to_tf",
        "_sf_to_td",
        "_df_to_td",
        "_xf_to_td",
        "_tf_to_td",
        "_td_to_sd",
        "_td_to_dd",
        "_unord_td",
    ],
}

RUNTIME_DEFINES = [
    "ENABLE_DECIMAL_BID_FORMAT=1",
    "IN_GCC=1",
    "IN_LIBGCC2=1",
    "GTHREAD_USE_WEAK=0",
    "HAVE_GTHR_DEFAULT=1",
    "HAVE_CC_TLS=1",
    "USE_TLS=1",
]

RUNTIME_FLAGS = [
    "-O2",
    "-fPIC",
    "-fbuilding-libgcc",
    "-fno-stack-protector",
    "-Werror",
]

RUNTIME_INCLUDES = [
    "libgcc",
    "libgcc/soft-fp",
    "libgcc/config/libbid",
    "compiler/gcc",
    "compiler/include",
]

[
    c_object(
        name = stage + "-libgcc" + name + ".o",
        src = ":" + stage + "-runtime-source[libgcc/libgcc2.c]",
        defines = RUNTIME_DEFINES + ["L" + name],
        flags = RUNTIME_FLAGS + ([
            "-fexceptions",
            "-fnon-call-exceptions",
        ] if name in LIBGCC_DIVMOD else []),
        logical_includes = RUNTIME_INCLUDES,
        logical_source = "libgcc/libgcc2.c",
        object_name = "lg" + str(i) + ".o",
        source_alias = SOURCE_ALIAS,
        source_tree = ":" + stage + "-runtime-source",
        toolchain = ":" + stage + "-bootstrap-gcc",
    )
    for stage in STAGES
    for i, name in enumerate(LIBGCC_FUNCTIONS + LIBGCC_DIVMOD)
]

[
    c_object(
        name = stage + "-runtime-" + name + ".o",
        src = ":" + stage + "-runtime-source[" + source + "]",
        defines = RUNTIME_DEFINES,
        flags = RUNTIME_FLAGS,
        logical_includes = RUNTIME_INCLUDES,
        logical_source = source,
        object_name = "rt" + str(i) + ".o",
        source_alias = SOURCE_ALIAS,
        source_tree = ":" + stage + "-runtime-source",
        toolchain = ":" + stage + "-bootstrap-gcc",
    )
    for stage in STAGES
    for i, (name, source) in enumerate(RUNTIME_OBJECTS.items())
]

[
    c_object(
        name = stage + "-dfp" + name + ".o",
        src = ":" + stage + "-runtime-source[libgcc/config/libbid/" + name + ".c]",
        defines = RUNTIME_DEFINES + [
            "L" + name,
            "FINE_GRAINED_LIBRARIES=1",
            "WIDTH=" + width,
        ],
        flags = RUNTIME_FLAGS,
        logical_includes = RUNTIME_INCLUDES,
        logical_source = "libgcc/config/libbid/" + name + ".c",
        object_name = "df" + width + "_" + str(i) + ".o",
        source_alias = SOURCE_ALIAS,
        source_tree = ":" + stage + "-runtime-source",
        toolchain = ":" + stage + "-bootstrap-gcc",
    )
    for stage in STAGES
    for width, names in DFP_OBJECTS.items()
    for i, name in enumerate(names)
]

[
    c_library(
        name = stage + "-libgcc.a",
        objects = [":" + stage + "-libgcc" + name + ".o" for name in LIBGCC_FUNCTIONS + LIBGCC_DIVMOD] +
                  [":" + stage + "-runtime-" + name + ".o" for name in RUNTIME_OBJECTS] +
                  [":" + stage + "-dfp" + name + ".o" for names in DFP_OBJECTS.values() for name in names],
        output = "libgcc.a",
        toolchain = ":" + stage + "-bootstrap-gcc",
    )
    for stage in STAGES
]

[
    c_object(
        name = stage + "-lib" + name + ".o",
        src = ":" + stage + "-runtime-source[libgcc/libgcov.c]",
        defines = RUNTIME_DEFINES + ["L" + name],
        flags = RUNTIME_FLAGS,
        logical_includes = RUNTIME_INCLUDES,
        logical_source = "libgcc/libgcov.c",
        object_name = "cov" + str(i) + ".o",
        source_alias = SOURCE_ALIAS,
        source_tree = ":" + stage + "-runtime-source",
        toolchain = ":" + stage + "-bootstrap-gcc",
    )
    for stage in STAGES
    for i, name in enumerate(LIBGCOV_FUNCTIONS)
]

[
    c_library(
        name = stage + "-libgcov.a",
        objects = [":" + stage + "-lib" + name + ".o" for name in LIBGCOV_FUNCTIONS],
        output = "libgcov.a",
        toolchain = ":" + stage + "-bootstrap-gcc",
    )
    for stage in STAGES
]

[
    c_object(
        name = stage + "-" + name,
        src = ":" + stage + "-runtime-source[libgcc/crtstuff.c]",
        defines = [
            "IN_GCC=1",
            "HAVE_GTHR_DEFAULT=1",
            "GTHREAD_USE_WEAK=0",
        ] + defines,
        flags = [
            "-O2",
            "-g0",
            "-finhibit-size-directive",
            "-fno-inline",
            "-fno-exceptions",
            "-fno-zero-initialized-in-bss",
            "-fno-toplevel-reorder",
            "-fno-tree-vectorize",
            "-fno-stack-protector",
            "-fno-omit-frame-pointer",
            "-fno-asynchronous-unwind-tables",
            "-Werror",
        ],
        logical_includes = RUNTIME_INCLUDES,
        logical_source = "libgcc/crtstuff.c",
        object_name = name,
        source_alias = SOURCE_ALIAS,
        source_tree = ":" + stage + "-runtime-source",
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
        src = ":" + stage + "-runtime-source[libgcc/config/i386/" + source + "]",
        defines = RUNTIME_DEFINES + defines,
        flags = RUNTIME_FLAGS + flags,
        logical_includes = RUNTIME_INCLUDES,
        logical_source = "libgcc/config/i386/" + source,
        object_name = name,
        source_alias = SOURCE_ALIAS,
        source_tree = ":" + stage + "-runtime-source",
        toolchain = ":" + stage + "-bootstrap-gcc",
    )
    for stage in STAGES
    for name, source, defines, flags in [
        (
            "crtprec32.o",
            "crtprec.c",
            ["__PREC=32"],
            [],
        ),
        (
            "crtprec64.o",
            "crtprec.c",
            ["__PREC=64"],
            [],
        ),
        (
            "crtprec80.o",
            "crtprec.c",
            ["__PREC=80"],
            [],
        ),
        (
            "crtfastmath.o",
            "crtfastmath.c",
            [],
            [
                "-msse",
                "-minline-all-stringops",
            ],
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
            stage = "gcc-4.7.4-" + stage + "-native-runtime",
            sysroot = ":" + stage + "-runtime",
            target_compatible_with = [
                "cellar//bootstrap/platforms:linux",
                "cellar//bootstrap/platforms:amd64",
            ],
        ),
    ]
    for stage in STAGES
]

export_file(name = "tests/extended-float.c")

[
    [
        generate(
            name = "runtime-" + name + "-program",
            args = [
                "-O2",
                "-g0",
                "-frandom-seed=bootstrap",
                "-fexceptions",
                "-fno-optimize-sibling-calls",
                "$(location " + source + ")",
                "-o",
                "program",
            ],
            chdir = "cellar//bootstrap/stage0-posix/cellar-extra:chdirenv",
            directory = True,
            files = ["program"],
            tool = ":stage1-gcc",
        ),
        command_test(
            name = "runtime-" + name,
            args = [
                "0",
                "$(location :runtime-" + name + "-program[program])",
            ] + ([
                "startup",
                "ok",
            ] if name == "startup" else []),
            env = {"BOOTSTRAP_TEST": "present"},
            tool = "cellar//bootstrap/stage1/tools:expect-exit",
        ),
    ]
    for name, source in [
        ("integer-complex", "cellar//bootstrap/stage1/gcc40:tests/libgcc.c"),
        ("unwind", "cellar//bootstrap/stage1/gcc40:tests/unwind.c"),
        ("extended-float", ":tests/extended-float.c"),
        ("c-language", "cellar//bootstrap/stage1/gcc40:tests/c-language.c"),
        ("startup", "cellar//bootstrap/stage1/musl:test-source[tests/runtime.c]"),
        ("threads", "cellar//bootstrap/stage1/musl:test-source[tests/threads.c]"),
        ("math", "cellar//bootstrap/stage1/musl:test-source[tests/native-math.c]"),
        ("unicode", "cellar//bootstrap/stage1/musl:test-source[tests/unicode.c]"),
    ]
]

command_test(
    name = "runtime-missing-library",
    args = [
        "1",
        "$(exe :stage1-xgcc)",
        "-B$(location :stage1-native-tools)/",
        "-nostdlib",
        "$(location :driver-test-c.o)",
        "-lstdc++",
        "-o",
        "/dev/null",
    ],
    env = {
        "TMPDIR": ".",
        "PATH": "/usr/bin:/bin",
    },
    host_paths = True,
    tool = "cellar//bootstrap/stage1/tools:expect-exit",
)

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
    tool = "cellar//bootstrap/stage1/tools:expect-exit",
)

export_file(name = "tests/coverage.c")

c_object(
    name = "coverage-runner.o",
    src = "tests/coverage-runner.c",
    flags = [
        "-O2",
        "-Werror",
    ],
    toolchain = PREDECESSOR,
)

c_binary(
    name = "coverage-runner",
    libraries = LIBC,
    objects = CRT + [":coverage-runner.o"] + CRTN,
    toolchain = PREDECESSOR,
)

generate(
    name = "coverage-result",
    args = [
        "$(exe :stage1-xgcc)",
        "$(location :stage1-native-tools)",
        "$(location :stage1-runtime)/lib/",
        "$(location :compiler-headers)",
        "$(location :stage1-runtime[include])",
        "$(location :tests/coverage.c)",
        "$(exe :stage1-gcov)",
    ],
    chdir = "cellar//bootstrap/stage0-posix/cellar-extra:chdirenv",
    directory = True,
    env = {"TMPDIR": "."},
    files = ["passed"],
    tool = ":coverage-runner",
)

write_file(
    name = "coverage-passed",
    content = "passed\n",
)

command_test(
    name = "runtime-coverage-roundtrip",
    args = [
        "$(location :coverage-result[passed])",
        "$(location :coverage-passed)",
    ],
    tool = CMP,
)

# Upstream bootstrap compares all stage2/stage3 objects; the two checksum
# objects encode their predecessor's link inputs and are the only exclusions.
HOST_OBJECTS = {"gen-" + name + ".o": "gen-" + name + ".o" for name in [
    "makeucnid",
    "crc-generator",
    "decDPD",
    "bid",
]} | {
    library + "-" + name.replace("/", "-") + ".o": library + "-" + name.replace("/", "-") + ".o"
    for library, (sources, _includes) in LIBRARIES.items()
    for name in sources
} | {
    name + ".o": name + ".o"
    for name in BASE_GENERATORS + ["errors"] + MACHINE_GENERATORS + RTL_SUPPORT + [
        "read-md",
        "gencondmd",
    ] + GTYPE_OBJECTS + [
        "genchecksum",
        "gcov-iov",
    ]
} | {"base-mode.o": "base-mode-object"} | {
    "cc-" + name.replace("/", "-") + ".o": "cc-" + name.replace("/", "-") + ".o"
    for name in COMPILER_OBJECTS
} | {"zlib-" + name + ".o": "zlib-" + name + ".o" for name in ZLIB_OBJECTS} | {
    "driver-" + name + ".o": "driver-" + name + ".o"
    for name in DRIVER_OBJECTS
} | {
    "cc1-checksum.o": "cc1-checksum.o",
    "cc1plus-checksum.o": "cc1plus-checksum.o",
}

COMPARE_EXCLUSIONS = [
    "cc1-checksum.o",
    "cc1plus-checksum.o",
]

[filegroup(
    name = stage + "-host-objects",
    srcs = {
        path: ":" + stage + "-" + target
        for path, target in HOST_OBJECTS.items()
    },
) for stage in STAGES]

[command_test(
    name = "compare-host-" + path,
    args = [
        "$(location :stage2-" + target + ")",
        "$(location :stage3-" + target + ")",
    ],
    tool = CMP,
) for path, target in HOST_OBJECTS.items() if path not in COMPARE_EXCLUSIONS]

RUNTIME_OBJECT_TARGETS = ["libgcc" + name + ".o" for name in LIBGCC_FUNCTIONS + LIBGCC_DIVMOD] + [
    "runtime-" + name + ".o"
    for name in RUNTIME_OBJECTS
] + ["dfp" + name + ".o" for names in DFP_OBJECTS.values() for name in names] + [
    "lib" + name + ".o"
    for name in LIBGCOV_FUNCTIONS
] + [
    "crtbeginT.o",
    "crtend.o",
    "crtprec32.o",
    "crtprec64.o",
    "crtprec80.o",
    "crtfastmath.o",
]

[filegroup(
    name = stage + "-runtime-objects",
    srcs = {
        name: ":" + stage + "-" + name
        for name in RUNTIME_OBJECT_TARGETS
    },
) for stage in STAGES]

[command_test(
    name = "compare-runtime-" + name,
    args = [
        "$(location :stage2-" + name + ")",
        "$(location :stage3-" + name + ")",
    ],
    tool = CMP,
) for name in RUNTIME_OBJECT_TARGETS + [
    "libgcc.a",
    "libgcov.a",
]]

filegroup(
    name = "stage-comparison",
    srcs = {},
    tests = [
        ":compare-host-" + path
        for path in HOST_OBJECTS
        if path not in COMPARE_EXCLUSIONS
    ] + [":compare-runtime-" + name for name in RUNTIME_OBJECT_TARGETS + [
        "libgcc.a",
        "libgcov.a",
    ]],
)

# Each self-built stage must pass the same target-runtime execution checks.
[[
    generate(
        name = stage + "-runtime-" + name + "-program",
        args = REPRODUCIBLE_FLAGS + [
            "-O2",
            "-fexceptions",
            "-fno-optimize-sibling-calls",
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
        name = stage + "-runtime-" + name,
        args = [
            "0",
            "$(location :" + stage + "-runtime-" + name + "-program[program])",
        ] + ([
            "startup",
            "ok",
        ] if name == "startup" else []),
        env = {"BOOTSTRAP_TEST": "present"},
        tool = "cellar//bootstrap/stage1/tools:expect-exit",
    ),
] for stage in [
    "stage2",
    "stage3",
] for name, source in [
    ("integer-complex", "cellar//bootstrap/stage1/gcc40:tests/libgcc.c"),
    ("unwind", "cellar//bootstrap/stage1/gcc40:tests/unwind.c"),
    ("extended-float", ":tests/extended-float.c"),
    ("c-language", "cellar//bootstrap/stage1/gcc40:tests/c-language.c"),
    ("startup", "cellar//bootstrap/stage1/musl:test-source[tests/runtime.c]"),
    ("threads", "cellar//bootstrap/stage1/musl:test-source[tests/threads.c]"),
    ("math", "cellar//bootstrap/stage1/musl:test-source[tests/native-math.c]"),
    ("unicode", "cellar//bootstrap/stage1/musl:test-source[tests/unicode.c]"),
]]

export_file(name = "tests/floating-point-environment.c")

# The driver adds upstream's x86 math startup files: crtfastmath.o for
# -ffast-math and crtprec32.o for -mpc32.
[[
    generate(
        name = stage + "-floating-point-" + name + "-program",
        args = REPRODUCIBLE_FLAGS + ["-O2"] + flags + [
            "$(location :tests/floating-point-environment.c)",
            "-o",
            "program",
        ],
        chdir = "cellar//bootstrap/stage0-posix/cellar-extra:chdirenv",
        directory = True,
        files = ["program"],
        tool = ":" + stage + "-gcc",
    ),
    command_test(
        name = stage + "-floating-point-" + name,
        args = [
            "0",
            "$(location :" + stage + "-floating-point-" + name + "-program[program])",
        ],
        tool = "cellar//bootstrap/stage1/tools:expect-exit",
    ),
] for stage in STAGES for name, flags in {
    "default": [],
    "fast-math": [
        "-ffast-math",
        "-DEXPECT_FAST_MATH=1",
    ],
    "x87-precision": [
        "-mpc32",
        "-DEXPECT_PRECISION=0",
    ],
}.items()]

[[
    generate(
        name = stage + "-coverage-result",
        args = [
            "$(exe :" + stage + "-xgcc)",
            "$(location :" + stage + "-native-tools)",
            "$(location :" + stage + "-runtime)/lib/",
            "$(location :compiler-headers)",
            "$(location :" + stage + "-runtime[include])",
            "$(location :tests/coverage.c)",
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
] for stage in [
    "stage2",
    "stage3",
]]

export_file(name = "tests/pthread-option.c")

[[
    generate(
        name = stage + "-pthread-driver-program",
        args = [
            "-O2",
            "-g0",
            "-frandom-seed=bootstrap",
            "-pthread",
            "$(location :tests/pthread-option.c)",
            "-o",
            "program",
        ],
        chdir = "cellar//bootstrap/stage0-posix/cellar-extra:chdirenv",
        directory = True,
        files = ["program"],
        tool = ":" + stage + "-gcc",
    ),
    command_test(
        name = stage + "-pthread-driver",
        args = [
            "0",
            "$(location :" + stage + "-pthread-driver-program[program])",
        ],
        tool = "cellar//bootstrap/stage1/tools:expect-exit",
    ),
] for stage in STAGES]

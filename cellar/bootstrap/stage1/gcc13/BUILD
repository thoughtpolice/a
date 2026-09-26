# SPDX-FileCopyrightText: 2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

load("@cellar//bootstrap:actions.bzl", "command_test", "compare_test", "generate")
load("@cellar//bootstrap:defs.bzl", "export_file")
load("@cellar//bootstrap:source.bzl", "exact_patch", "write_file")
load("@cellar//bootstrap/stage1/gcc:defs.bzl", "EXPECT_EXIT", "GCC40", "GCC47", "SED", "STAGES", "gcc_port")
load("@cellar//bootstrap/stage1/mimalloc:defs.bzl", "mimalloc_object")
load(":config.bzl", "CONFIG")
load(":sources.bzl", "LIBCODY", "LIBCODY_FILES", "SOURCES")

BINUTILS = "cellar//bootstrap/stage1/binutils241"

# GCC 13 is written in C++11, so the final GCC 10 stage and its C++ library
# build the first stage.
gcc_port(
    archive_hash = "ec3df0015ed01411f91f9a9cd5b4da3070eb1222b02fadf4133c30c090399855",
    archive_size = 90977816,
    binutils = BINUTILS,
    # The compilers allocate heavily, and musl's allocator returns and maps
    # pages far more often than mimalloc. With it, the later stages compile
    # about 15% faster, with identical output. Each stage's host compiler
    # builds that stage's copy, so the stage comparison covers it too.
    compiler_objects = {"mimalloc.o": mimalloc_object},
    config = CONFIG,
    driver_lookup = "find_a_program(commands[0].prog)",
    # cc1plus's module mapper links libcody, with libcody/Makefile.in's
    # C++11 and forced configuration include.
    extra_libraries = {
        "libcody": struct(
            compiler_includes = ["libcody"],
            config = ":cody-config.h",
            files = LIBCODY_FILES,
            flags = [
                "-std=c++11",
                "-include",
                "config.h",
            ],
            includes = [
                "build/libcody",
                "libcody",
            ],
            language = "c++",
            license = "libcody/LICENSE",
            linked_by = ["cc1plus"],
            # fatal.cc names its source directory only for checking builds.
            object_defines = {"fatal": ['SRCDIR=""']},
            objects = LIBCODY,
            suffix = ".cc",
        ),
    },
    genversion = True,
    # cp/name-lookup.cc suggests standard headers through std-name-hint.h.
    gperf_tables = {
        "std-name-hint": struct(
            lookup = "find",
            prefix = "HINT",
            tests = "tests/std-name-hint-",
        ),
    },
    host = "cellar//bootstrap/stage1/gcc10",
    host_libstdcxx = "cellar//bootstrap/stage1/libstdcxx10",
    # uname2c.h maps Unicode names to code points for \N{...} escapes.
    libcpp_tables = {
        "unicode-names": struct(
            generator = "makeuname2c.cc",
            header = "uname2c.h",
            inputs = [
                "contrib/unicode/UnicodeData.txt",
                "contrib/unicode/NameAliases.txt",
            ],
        ),
    },
    libstdcxx = "cellar//bootstrap/stage1/libstdcxx13",
    runtime_tests = [
        # The driver passes --gdwarf-5 to binutils 2.41's assembler, which
        # writes the line table from GCC's .file and .loc directives.
        (
            "debug-info",
            GCC40 + ":tests/c-language.c",
            [
                "-std=gnu99",
                "-g",
            ],
        ),
        # The driver also links crtfastmath.o for -mdaz-ftz.
        (
            "daz-ftz",
            GCC47 + ":tests/floating-point-environment.c",
            [
                "-mdaz-ftz",
                "-DEXPECT_FAST_MATH=1",
            ],
        ),
    ],
    skip = [
        "gcc/m2",
        "gcc/rust",
    ],
    sources = SOURCES,
    suffix = ".cc",
    tmpdir_patch = ":patches/tmpdir.patch",
    # makeucnid also reads the XID properties C++23 identifiers use.
    ucnid_inputs = [
        "contrib/unicode/UnicodeData.txt",
        "contrib/unicode/DerivedNormalizationProps.txt",
        "contrib/unicode/DerivedCoreProperties.txt",
    ],
    unicode_version = "15.0.0",
    version = "13.5.0",
)

# Nodes with equal keys compare equal, and the shipped uname2c.h keeps them
# in insertion order, as glibc's merge-sort qsort does. musl's qsort does not,
# so sort them stably.
exact_patch(
    name = "makeuname2c-algorithm.cc",
    src = ":gcc-13.5.0[libcpp/makeuname2c.cc]",
    after = "#include <stdlib.h>\n#include <algorithm>",
    before = "#include <stdlib.h>",
    output = "makeuname2c.cc",
)

exact_patch(
    name = "makeuname2c.cc",
    src = ":makeuname2c-algorithm.cc",
    after = "  std::stable_sort (nodes, nodes + num_nodes,\n\t\t    [] (const node *a, const node *b)\n\t\t    { return nodecmp (&a, &b) < 0; });",
    before = "  qsort (nodes, num_nodes, sizeof (struct node *), nodecmp);",
    output = "makeuname2c.cc",
)

# libcody/config.h.in for release checking; _GNU_SOURCE is AH_VERBATIM.
write_file(
    name = "cody-config.h",
    content = "#define NMS_CHECKING 0\n#define PACKAGE_BUGREPORT \"github.com/urnathan/libcody\"\n#define PACKAGE_NAME \"codylib\"\n#define PACKAGE_STRING \"codylib 0.0\"\n#define PACKAGE_TARNAME \"codylib\"\n#define PACKAGE_URL \"\"\n#define PACKAGE_VERSION \"0.0\"\n#undef _FORTIFY_SOURCE\n#define _GNU_SOURCE 1\n",
)

export_file(name = "patches/tmpdir.patch")

# gas writes the -g programs' line table from GCC's .file and .loc directives,
# so main's address maps to its line in the C source, not to the assembly.
write_file(
    name = "debug-info-expected.txt",
    content = "c-language.c:39\n",
)

[
    [
        generate(
            name = stage + "-debug-info-symbols.txt",
            args = ["$(location :" + stage + "-runtime-debug-info-O0-program[program])"],
            capture = True,
            tool = BINUTILS + ":nm",
        ),
        generate(
            name = stage + "-debug-info-main.txt",
            args = [
                "-n",
                "-e",
                "s/^\\([0-9a-f]*\\) T main$/0x\\1/p",
                "$(location :" + stage + "-debug-info-symbols.txt)",
            ],
            capture = True,
            tool = SED,
        ),
        generate(
            name = stage + "-debug-info-line.txt",
            args = [
                "-e",
                "$(location :" + stage + "-runtime-debug-info-O0-program[program])",
            ],
            capture = True,
            stdin = ":" + stage + "-debug-info-main.txt",
            tool = BINUTILS + ":addr2line",
        ),
        generate(
            name = stage + "-debug-info-source.txt",
            args = [
                "-e",
                "s|.*/||",
                "$(location :" + stage + "-debug-info-line.txt)",
            ],
            capture = True,
            tool = SED,
        ),
        compare_test(
            name = stage + "-debug-info-line-table",
            actual = ":" + stage + "-debug-info-source.txt",
            expected = ":debug-info-expected.txt",
        ),
    ]
    for stage in STAGES
]

# GCC 13 already rejects -fsplit-stack for musl. -mglibc would allow it but
# for tm.h removing glibc's thread control block offset. -nostdinc skips the
# stdc-predef.h preinclude, which needs a C library's headers.
[
    command_test(
        name = name,
        args = [
            status,
            "$(exe :stage1-cc1)",
            "-quiet",
            "-frandom-seed=bootstrap",
            "-nostdinc",
            "-mglibc",
        ] + flags + [
            "$(location :tiny.c)",
            "-o",
            "/dev/null",
        ],
        tool = EXPECT_EXIT,
    )
    for name, status, flags in [
        ("runtime-accept-glibc-option", "0", []),
        (
            "runtime-reject-glibc-split-stack",
            "1",
            ["-fsplit-stack"],
        ),
    ]
]

# The compilers link libbacktrace, whose BSD notice is in its source headers.
generate(
    name = "libbacktrace-notice",
    args = [
        "-n",
        "-e",
        "2,31{s|  \\*/$||;p;}",
        "$(location :gcc-13.5.0[libbacktrace/backtrace.h])",
    ],
    capture = True,
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
    capture = True,
    tool = SED,
)

write_file(
    name = "libbacktrace-notice-expected.txt",
    content = "   Copyright (C) 2012-2023 Free Software Foundation, Inc.\nPOSSIBILITY OF SUCH DAMAGE.\n30\n",
)

compare_test(
    name = "libbacktrace-license",
    actual = ":libbacktrace-notice-extent.txt",
    expected = ":libbacktrace-notice-expected.txt",
)

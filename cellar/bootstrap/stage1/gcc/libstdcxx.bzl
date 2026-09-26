# SPDX-FileCopyrightText: © 2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

# libstdc++ for GCC 10 and later: each stage of a gcc_port compiles the
# library's translation units with that stage's compiler and archives them as
# an upstream --disable-shared build does. No configure or Make process runs.

load("@cellar//bootstrap:actions.bzl", "command_test", "compare_test", "concatenate", "configured_tool", "generate", "result_test")
load("@cellar//bootstrap:defs.bzl", "filegroup")
load("@cellar//bootstrap:source.bzl", "project_files", "write_file")
load("@cellar//bootstrap/stage1:defs.bzl", "bootstrap_artifact", "c_library", "c_object")
load(":defs.bzl", "CATM", "EXPECT_EXIT", "SED", "SHARED", "STAGES")

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

# Programs each stage's g++ builds and runs at -O0 and -O2, with their
# dialects: exceptions across translation units, the standalone ABI library,
# C++98 containers, C++11 facilities, threads, streams and C++17.
TESTS = {
    "exceptions": "gnu++11",
    "supcxx": "gnu++98",
    "containers": "gnu++98",
    "cxx11": "gnu++11",
    "threads": "gnu++11",
    "streams": "gnu++98",
    "cxx17": "gnu++17",
}

TEST_SOURCES = [
    "exception.h",
    "supcxx.cc",
    "throw.cc",
    "exceptions.cc",
    "containers.cc",
    "cxx11.cc",
    "threads.cc",
    "streams.cc",
    "cxx17.cc",
]

THREADED_TESTS = [
    "threads",
    "cxx17",
]

# Programs that write files run in their own output directory.
WRITING_TESTS = [
    "streams",
    "cxx17",
]

def libstdcxx_port(
        version,
        gcc,
        binutils,
        library_objects,
        header_files,
        config_on,
        config_values,
        archives,
        cxxconfig_edits = [],
        deleted_config = [],
        source_files = [],
        tree = {},
        tests = {}):
    """Declares one release's libstdc++ for each stage of its gcc_port.

    Args:
        version: the GCC release, such as "10.5.0".
        gcc: the gcc_port package, whose extracted release and stage
            compilers build the library.
        binutils: package whose as assembles cxx11-ios_failure.
        library_objects: translation units in upstream archive order:
            (group, object, source, flags).
        header_files: installed header path to release path.
        config_on: config.h macros defined as 1.
        config_values: config.h macros with values.
        archives: each archive's name without lib and .a, and its groups.
        cxxconfig_edits: further sed expressions for bits/c++config.h.
        deleted_config: further config.h macros c++config.h leaves out.
        source_files: further release files the sources read.
        tree: further files in the source tree, by path.
        tests: further test programs, by name: struct(standard, source,
            threaded).
    """
    source = ":gcc-" + version
    source_files = SOURCE_FILES + source_files

    # The compiler package extracts the same release; build from its tree.
    project_files(
        name = source[1:],
        files = SOURCE_DIRECTORIES + source_files + ["gcc/DATESTAMP"] + {path: None for path in header_files.values()}.keys(),
        tree = gcc + source,
    )

    write_file(
        name = "config.h",
        content = "\n".join(["#define " + name + " 1" for name in config_on]) + "\n" + "\n".join(["#define " + name + " " + value for name, value in config_values.items()]) + "\n",
    )

    # stamp-cxx-config dates the library with gcc/DATESTAMP.
    generate(
        name = "glibcxx-date.sed",
        args = [
            "-e",
            "s/^[0-9][0-9]*$/s,define __GLIBCXX__,define __GLIBCXX__ &,/",
            "$(location " + source + "[gcc/DATESTAMP])",
        ],
        capture = True,
        tool = SED,
    )

    # libstdc++-v3/include/Makefile.am's stamp-cxx-config pipeline.
    generate(
        name = "cxxconfig-base",
        args = [
            "-f",
            "$(location :glibcxx-date.sed)",
        ] + [arg for edit in [
            "s,define _GLIBCXX_RELEASE,define _GLIBCXX_RELEASE " + version.split(".")[0] + ",",
            "s,define _GLIBCXX_INLINE_VERSION, define _GLIBCXX_INLINE_VERSION 0,",
            "s,define _GLIBCXX_HAVE_ATTRIBUTE_VISIBILITY, define _GLIBCXX_HAVE_ATTRIBUTE_VISIBILITY 1,",
            "s,define _GLIBCXX_EXTERN_TEMPLATE$, define _GLIBCXX_EXTERN_TEMPLATE 1,",
            "s,define _GLIBCXX_USE_DUAL_ABI, define _GLIBCXX_USE_DUAL_ABI 1,",
            "s,define _GLIBCXX_USE_CXX11_ABI, define _GLIBCXX_USE_CXX11_ABI 1,",
            "s,define _GLIBCXX_USE_ALLOCATOR_NEW, define _GLIBCXX_USE_ALLOCATOR_NEW 1,",
            "s,define _GLIBCXX_USE_FLOAT128,define _GLIBCXX_USE_FLOAT128 1,",
        ] + cxxconfig_edits for arg in [
            "-e",
            edit,
        ]] + ["$(location " + source + "[libstdc++-v3/include/bits/c++config])"],
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
        ] + [arg for name in ["_GLIBCXX_LONG_DOUBLE_COMPAT"] + deleted_config for arg in [
            "-e",
            "/[\t ]" + name + "[\t ]/d",
        ]] + ["$(location :config.h)"],
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
        tool = CATM,
    )

    [
        generate(
            name = name,
            args = [arg for transform in transforms for arg in [
                "-e",
                transform,
            ]] + ["$(location " + source + "[libgcc/" + name + "])"],
            capture = True,
            output = name,
            tool = SED,
        )
        for name, transforms in GTHREAD_TRANSFORMS.items()
    ]

    # libgcc/gthr-posix.h has no quoted includes, so the default thread header
    # is the transformed POSIX header.
    filegroup(
        name = "headers",
        srcs = {name: source + "[" + path + "]" for name, path in header_files.items()} | {
            "bits/c++config.h": ":c++config.h",
            "bits/gthr.h": ":gthr.h",
            "bits/gthr-single.h": ":gthr-single.h",
            "bits/gthr-posix.h": ":gthr-posix.h",
            "bits/gthr-default.h": ":gthr-posix.h",
        },
    )

    # AC_SYS_LARGEFILE defines nothing on LP64, but the filesystem sources
    # include the build-only header.
    write_file(
        name = "largefile-config.h",
        content = "",
    )

    # A file listed for its own projection may already lie in a listed
    # directory, and the tree takes it from there.
    tree_files = [
        path
        for path in source_files
        if not [directory for directory in SOURCE_DIRECTORIES if path.startswith(directory + "/")]
    ]

    [
        filegroup(
            name = stage + "-source",
            srcs = {path: source + "[" + path + "]" for path in SOURCE_DIRECTORIES + tree_files} | {
                "headers": ":headers",
                "build/bits/largefile-config.h": ":largefile-config.h",
                "config.h": ":config.h",
            } | tree,
        )
        for stage in STAGES
    ]

    [
        c_object(
            name = stage + "-" + group + "-" + name + ".o",
            src = ":" + stage + "-source",
            flags = LIBRARY_FLAGS + ([] if path.endswith(".c") else [
                "-x",
                "c++",
            ]) + flags + (["-Isource/headers/backward"] if name == "strstream" else []),
            logical_includes = LIBRARY_INCLUDES,
            logical_source = path,
            object_name = "cx" + str(i) + ".o",
            source_tree = ":" + stage + "-source",
            toolchain = gcc + ":" + stage + "-gcc",
        )
        for stage in STAGES
        for i, (group, name, path, flags) in enumerate(library_objects)
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
                ] + flags + ["-Isource/" + include for include in LIBRARY_INCLUDES] + [
                    "-S",
                    "source/" + path,
                    "-o",
                    "unit.s",
                ],
                chdir = True,
                directory = True,
                files = ["unit.s"],
                source_tree = ":" + stage + "-source",
                tool = gcc + ":" + stage + "-gcc-command",
            ),
            generate(
                name = stage + "-" + IOS_FAILURE + "-rewritten.s",
                args = [
                    "-e",
                    "/^_*_ZTISt13__ios_failure:/,/_ZTVN10__cxxabiv120__si_class_type_infoE/s/_ZTVN10__cxxabiv120__si_class_type_infoE/_ZTVSt19__iosfail_type_info/",
                    "$(location :" + stage + "-" + IOS_FAILURE + ".s[unit.s])",
                ],
                capture = True,
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
                tool = binutils + ":as",
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
        for group, name, path, flags in library_objects
        if name == IOS_FAILURE
    ]

    [c_library(
        name = stage + "-lib" + library + ".a",
        objects = [":" + stage + "-" + group + "-" + name + ".o" for group, name, path, flags in library_objects if group in groups],
        output = "lib" + library + ".a",
        toolchain = gcc + ":" + stage + "-gcc",
    ) for stage in STAGES for library, groups in archives.items()]

    [filegroup(
        name = stage + "-libraries",
        srcs = {"lib" + library + ".a": ":" + stage + "-lib" + library + ".a" for library in archives},
    ) for stage in STAGES]

    [configured_tool(
        name = stage + "-g++",
        args = [
            "-B$(location " + gcc + ":" + stage + "-native-tools)/",
            "-B$(location " + gcc + ":" + stage + "-runtime)/lib/",
            "-L$(location :" + stage + "-libraries)",
            "-nostdinc",
            "-nostdinc++",
            "-isystem",
            "$(location :headers)",
            "-isystem",
            "$(location " + gcc + ":compiler-headers)",
            "-isystem",
            "$(location " + gcc + ":" + stage + "-runtime[include])",
        ],
        env = {"TMPDIR": "."},
        tool = gcc + ":" + stage + "-g++",
    ) for stage in STAGES]

    filegroup(
        name = "tests",
        srcs = {"tests/" + name: SHARED + ":tests/libstdcxx/" + name for name in TEST_SOURCES} | {
            "tests/" + name + ".cc": test.source
            for name, test in tests.items()
        },
    )

    threaded = THREADED_TESTS + [name for name, test in tests.items() if test.threaded]
    [generate(
        name = stage + "-" + name + "-" + optimization + "-program",
        args = [
            "-" + optimization,
            "-g0",
            "-frandom-seed=bootstrap",
            "-Werror",
            "-std=" + standard,
            "source/tests/" + name + ".cc",
        ] + (["-pthread"] if name in threaded else []) + (["source/tests/throw.cc"] if name in [
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
    ) for stage in STAGES for name, standard in (TESTS | {name: test.standard for name, test in tests.items()}).items() for optimization in [
        "O0",
        "O2",
    ]]

    [command_test(
        name = stage + "-" + name + "-" + optimization,
        args = [
            "0",
            "$(location :" + stage + "-" + name + "-" + optimization + "-program[program])",
        ],
        tool = EXPECT_EXIT,
    ) for stage in STAGES for name in list(TESTS) + list(tests) if name not in WRITING_TESTS for optimization in [
        "O0",
        "O2",
    ]]

    [[
        generate(
            name = stage + "-" + name + "-" + optimization + "-work",
            args = [
                "0",
                "$(location :" + stage + "-" + name + "-" + optimization + "-program[program])",
            ],
            chdir = True,
            directory = True,
            files = ["passed"],
            tool = EXPECT_EXIT,
        ),
        result_test(
            name = stage + "-" + name + "-" + optimization,
            result = ":" + stage + "-" + name + "-" + optimization + "-work[passed]",
        ),
    ] for stage in STAGES for name in WRITING_TESTS for optimization in [
        "O0",
        "O2",
    ]]

    # Stage2 and stage3 compile every object and archive byte for byte alike.
    compared = [group + "-" + name + ".o" for group, name, path, flags in library_objects] + ["lib" + library + ".a" for library in archives]

    [compare_test(
        name = "compare-" + name,
        actual = ":stage2-" + name,
        expected = ":stage3-" + name,
    ) for name in compared]

    filegroup(
        name = "stage-comparison",
        srcs = {},
        tests = [":compare-" + name for name in compared],
    )

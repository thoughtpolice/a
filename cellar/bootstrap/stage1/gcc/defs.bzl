# SPDX-FileCopyrightText: © 2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

# GCC 10 and later, bootstrapped through three stages. Each release's package
# calls gcc_port with its archive, host compilers, binutils, file lists and
# reviewed configuration. The regenerated sources, support libraries,
# generators, compilers, drivers, target runtime, tests and stage comparison
# follow the one description below. No configure or Make process runs.

load("@cellar//bootstrap:actions.bzl", "command_test", "compare_test", "concatenate", "configured_tool", "generate", "result_test")
load("@cellar//bootstrap:defs.bzl", "export_file", "filegroup")
load("@cellar//bootstrap:source.bzl", "download_file", "exact_patch", "untar", "write_file")
load("@cellar//bootstrap/stage1:defs.bzl", "c_binary", "c_library", "c_object", "compiler", "link_runtime", "sysroot")

SHARED = "cellar//bootstrap/stage1/gcc"

GCC40 = "cellar//bootstrap/stage1/gcc40"

GCC47 = "cellar//bootstrap/stage1/gcc47"

MUSL = "cellar//bootstrap/stage1/musl12"

SED = "cellar//bootstrap/stage1/sed:sed"

GAWK = "cellar//bootstrap/stage1/gawk-final:gawk"

CATM = "cellar//bootstrap/stage0-posix/mescc-tools-extra:catm"

EXPECT_EXIT = "cellar//bootstrap/stage1/tools:expect-exit"

# Every compiler stage instantiates the generators and support libraries anew.
# Host programs link their predecessor's C runtime and C++ library; target
# libraries are built by, and belong to, the newly built compiler.
STAGES = [
    "stage1",
    "stage2",
    "stage3",
]

PREDECESSOR = {
    "stage2": "stage1",
    "stage3": "stage2",
}

# The C and C++ compilers follow gcc/Makefile.in, c/Make-lang.in and
# cp/Make-lang.in.
TARGET = "x86_64-cellar-linux-musl"

GCC_PREFIX = "/nonexistent-bootstrap-gcc"

SYSROOT = "/nonexistent-bootstrap-sysroot"

REPRODUCIBLE_FLAGS = [
    "-frandom-seed=bootstrap",
    "-g0",
    "-Wno-builtin-macro-redefined",
    '-D__DATE__="Jan  1 1970"',
    '-D__TIME__="00:00:00"',
    '-D__TIMESTAMP__="Thu Jan  1 00:00:00 1970"',
]

def gcc_compiler(name, command, sysroot, binutils):
    """A static x86_64 GCC compiler that runs on musl 1.2.5.

    Args:
        name: target name.
        command: the driver, as a runnable target.
        sysroot: the C library and runtime the driver links against.
        binutils: package whose ar and ld archive and link its output.
    """
    compiler(
        name = name,
        abi = "x86_64-sysv",
        archive_flags = ["crsD"],
        archive_format = "ar",
        archiver = binutils + ":ar",
        cflags = REPRODUCIBLE_FLAGS,
        compiler = command,
        execution_runtime = MUSL + ":runtime",
        family = "gcc",
        ldflags = ["-static"],
        linker = binutils + ":ld",
        object_format = "elf64-x86-64",
        sysroot = sysroot,
    )

def _mkconfig(guard, includes, defines = [], header = None, after = ""):
    """Reproduce gcc/mkconfig.sh for one configuration header."""
    lines = ["#ifndef " + guard, "#define " + guard]
    if guard == "GCC_CONFIG_H":
        lines += [
            "#ifdef GENERATOR_FILE",
            "#error config.h is for the host, not build, machine.",
            "#endif",
        ]
    for name, value in defines:
        lines += [
            "#ifndef " + name,
            "# define " + name + (" " + value if value else ""),
            "#endif",
        ]
    if header:
        lines.append('#include "' + header + '"')
    if includes:
        lines.append("#ifdef IN_GCC")
        lines += ['# include "' + name + '"' for name in includes]
        lines.append("#endif")
    return "\n".join(lines) + "\n" + after + "#endif /* " + guard + " */\n"

def gcc_port(
        version,
        archive_hash,
        archive_size,
        host,
        host_libstdcxx,
        binutils,
        libstdcxx,
        sources,
        config,
        suffix,
        ucnid_inputs,
        unicode_version,
        driver_lookup,
        tmpdir_patch,
        genversion,
        skip = [],
        libcpp_tables = {},
        gperf_tables = {},
        extra_libraries = {},
        runtime_tests = [],
        compiler_objects = {}):
    """Declares one GCC release's three stages and their tests.

    Args:
        version: the release, such as "10.5.0".
        archive_hash: SHA-256 of gcc-<version>.tar.xz.
        archive_size: its size in bytes.
        host: gcc package whose stage3 compiler and runtime build stage1.
        host_libstdcxx: the C++ library package that goes with host.
        binutils: package whose as, ar and ld every stage uses.
        libstdcxx: this release's C++ library package, which each later
            stage's host programs link.
        sources: struct of this release's file and object lists.
        config: struct of this release's reviewed configuration values.
        suffix: ".c" or ".cc", the suffix of the release's gcc/ and libcpp
            sources and of the sources its generators write. A gcc/ source
            the release already names .cc keeps that suffix.
        ucnid_inputs: the Unicode data makeucnid reads after ucnid.tab, as
            release paths or labels.
        unicode_version: the Unicode version of contrib/unicode, which
            generators/wcwidth.c reads.
        driver_lookup: the call with which the driver looks up a pipeline
            member's program.
        tmpdir_patch: the change that makes a missing TMPDIR fatal in
            libiberty's make-temp-file.c.
        genversion: True when gcc/genversion writes version.h. Otherwise
            gengtype links version.c and gcov-iov writes gcov-iov.h.
        skip: directories to leave out of the extraction beyond the shared
            list, such as other front ends.
        libcpp_tables: further libcpp tables to regenerate, by regeneration
            test name: struct(header, generator, inputs), where generator
            is a patched generator source in the calling package.
        gperf_tables: further gperf tables, by name: struct(lookup, tests,
            prefix), where tests prefixes the lookup and main test sources
            and prefix names their macros.
        extra_libraries: further support libraries, by name: struct(objects,
            files, language, suffix, includes, config, object_defines,
            flags, compiler_includes, linked_by, license).
        runtime_tests: further runtime tests: (name, source, flags).
        compiler_objects: objects linked into cc1 and cc1plus, by name:
            macro(name, toolchain), called for each stage with its host C
            compiler.
    """
    p = _port(
        version = version,
        host = host,
        host_libstdcxx = host_libstdcxx,
        binutils = binutils,
        libstdcxx = libstdcxx,
        sources = sources,
        config = config,
        suffix = suffix,
        genversion = genversion,
        ucnid_inputs = ucnid_inputs,
        libcpp_tables = libcpp_tables,
        gperf_tables = gperf_tables,
        extra_libraries = extra_libraries,
        compiler_objects = compiler_objects,
    )
    _release(p, archive_hash, archive_size, skip)
    _host_compiler(p)
    _tables(p, unicode_version)
    _support_libraries(p, tmpdir_patch)
    _library_tests(p)
    _gengtype_scanner(p)
    _configuration(p)
    _generated_sources(p)
    _generators(p)
    _compilers(p)
    _driver(p, driver_lookup)
    _runtime(p)
    _acceptance_tests(p, runtime_tests)
    _stage_comparison(p)

def _location(p, source):
    """A $(location) for a release path, or for a label starting with ":"."""
    if source.startswith(":"):
        return "$(location " + source + ")"
    return "$(location " + p.source + "[" + source + "])"

def _port(
        version,
        host,
        host_libstdcxx,
        binutils,
        libstdcxx,
        sources,
        config,
        suffix,
        genversion,
        ucnid_inputs,
        libcpp_tables,
        gperf_tables,
        extra_libraries,
        compiler_objects):
    host_name = host.rpartition("/")[2]
    cc_files = {path: None for path in sources.gcc_files if path.endswith(".cc")}

    # libcpp's Unicode tables that GCC's own generators write, by
    # regeneration test. Every release has ucnid.h; libcpp_tables adds the
    # rest.
    tables = {
        "unicode": struct(
            header = "ucnid.h",
            generator = "makeucnid" + suffix,
            inputs = ["libcpp/ucnid.tab"] + ucnid_inputs,
        ),
    } | libcpp_tables

    # The table generator programs and their languages. A libcpp generator's
    # language follows its suffix. generators/wcwidth.c stands in for GCC's
    # Python script.
    generator_programs = {
        table.generator.rpartition(".")[0]: "c++" if table.generator.endswith(".cc") else "c"
        for table in tables.values()
    } | {
        "crc-generator": "c",
        "decDPD": "c",
        "wcwidth": "c",
    }

    # cp/except recognizes nonthrowing C library calls through gperf's cfns.h.
    gperf = {
        "cfns": struct(
            lookup = "libc_name_p",
            tests = SHARED + ":tests/cfns-",
            prefix = "CFNS",
        ),
    } | gperf_tables

    # Upstream REQUIRED_OFILES, libcpp_a_OBJS, native BID libdecnumber
    # objects and the ELF/mmap libbacktrace configuration, with their
    # includes and flags.
    libraries = {
        "libiberty": struct(
            objects = sources.libiberty,
            language = "c",
            suffix = ".c",
            includes = [
                "build/libiberty",
                "libiberty",
                "include",
            ],
            defines = ["HAVE_CONFIG_H=1"],
            object_defines = {},
            flags = [],
            linked_by = [],
        ),
        "libcpp": struct(
            objects = sources.libcpp,
            language = "c++",
            suffix = suffix,
            includes = [
                "libcpp",
                "libcpp/include",
                "include",
            ],
            defines = ["HAVE_CONFIG_H=1"],
            object_defines = {},
            flags = [],
            linked_by = [],
        ),
        "libdecnumber": struct(
            objects = sources.libdecnumber,
            language = "c",
            suffix = ".c",
            includes = [
                "libdecnumber",
                "libdecnumber/bid",
            ],
            defines = ["HAVE_CONFIG_H=1"],
            object_defines = {},
            flags = [],
            linked_by = [],
        ),
        "libbacktrace": struct(
            objects = sources.libbacktrace,
            language = "c",
            suffix = ".c",
            includes = [
                "build/libbacktrace",
                "libbacktrace",
                "include",
            ],
            defines = ["HAVE_CONFIG_H=1"],
            object_defines = {},
            flags = ["-funwind-tables"],
            linked_by = [],
        ),
    } | {
        name: struct(
            objects = library.objects,
            language = library.language,
            suffix = library.suffix,
            includes = library.includes,
            defines = [],
            object_defines = library.object_defines,
            flags = library.flags,
            linked_by = library.linked_by,
        )
        for name, library in extra_libraries.items()
    }

    # Generator objects and the first generator tree that can compile each.
    # With genversion, version.h is a generator output that gengtype
    # includes. Without it, gengtype links version.c, and gcov-iov writes
    # gcov-iov.h.
    generator_objects = {
        "errors": 0,
        "genmodes": 0,
        "gengenrtl": 0,
    } | ({"genversion": 0} if genversion else {}) | {
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
        "gengtype": 1 if genversion else 0,
        "gengtype-lex": 0,
        "gengtype-parse": 0,
        "gengtype-state": 1 if genversion else 0,
    } | ({} if genversion else {
        "version": 0,
        "gcov-iov": 2,
    }) | {
        "genchecksum": 2,
        "gencondmd": 3,
        "genmatch": 4,
    }

    # Each compiler object is compiled once.
    compiler_object_names = {name: None for name in sources.backend_objects + sources.common_objects + sources.common_target_objects + sources.c_objects + sources.cxx_objects + ["main"]}

    return struct(
        version = version,
        major = version.split(".")[0],
        source = ":gcc-" + version,
        suffix = suffix,
        cc_files = cc_files,
        binutils = binutils,
        host = host,
        host_name = host_name,
        host_libstdcxx = host_libstdcxx,
        libstdcxx = libstdcxx,
        sources = sources,
        config = config,
        genversion = genversion,
        tables = tables,
        generator_programs = generator_programs,
        gperf = gperf,
        libraries = libraries,
        extra_libraries = extra_libraries,
        generator_objects = generator_objects,
        compiler_object_names = compiler_object_names,
        compiler_objects = compiler_objects,
        host_cc = {"stage1": host + ":stage3-gcc"} | {stage: ":" + previous + "-gcc" for stage, previous in PREDECESSOR.items()},
        host_cxx = {"stage1": ":" + host_name + "-g++"} | {stage: ":" + previous + "-host-g++" for stage, previous in PREDECESSOR.items()},
        host_runtime = {"stage1": host + ":stage3-link-runtime"} | {stage: ":" + previous + "-link-runtime" for stage, previous in PREDECESSOR.items()},
        # C++ programs also link the predecessor's standard library.
        host_libcxx = {"stage1": [host_libstdcxx + ":stage3-libstdc++.a"]} | {
            stage: [libstdcxx + ":" + previous + "-libstdc++.a"]
            for stage, previous in PREDECESSOR.items()
        },
    )

def _gcc_source(p, name):
    """gcc/<name> with the suffix of the release's source."""
    if "gcc/" + name + ".cc" in p.cc_files:
        return "gcc/" + name + ".cc"
    return "gcc/" + name + p.suffix

def _host_program(p, name, stage, objects, language = "c", libraries = [], output = None):
    """A build-machine program linked by the stage's host compiler.

    The link adds the host runtime and, for C++, the host's standard library.
    """
    c_binary(
        name = name,
        libraries = libraries + (p.host_libcxx[stage] if language == "c++" else []),
        objects = objects,
        output = output or "program",
        runtime = p.host_runtime[stage],
        toolchain = p.host_cc[stage],
    )

# Small support directories are projected whole. The gcc, libcpp and
# libdecnumber trees use manifests that withhold the files the port
# regenerates.
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

# Only what the compilers and their C++ library read: no test suites,
# translations, manuals or other languages' front ends and runtimes.
EXTRACTED = [
    "COPYING.RUNTIME",
    "COPYING3",
    "COPYING3.LIB",
    "contrib",
    "gcc",
    "include",
    "libbacktrace",
    "libcpp",
    "libdecnumber",
    "libgcc",
    "libiberty",
    "libstdc++-v3",
]

SKIPPED = [
    "gcc/testsuite",
    "gcc/po",
    "gcc/doc",
    "gcc/ada",
    "gcc/fortran",
    "gcc/go",
    "gcc/jit",
    "gcc/objc",
    "gcc/objcp",
    "libstdc++-v3/testsuite",
    "libstdc++-v3/doc",
    "libstdc++-v3/po",
]

LICENSES = [
    "COPYING.RUNTIME",
    "COPYING3",
    "COPYING3.LIB",
]

def _release(p, archive_hash, archive_size, skip):
    download_file(
        name = "gcc-" + p.version + ".tar.xz",
        hash = archive_hash,
        size_bytes = archive_size,
        urls = ["https://mirrors.kernel.org/gnu/gcc/gcc-{0}/gcc-{0}.tar.xz".format(p.version)],
    )

    unicode = [
        path
        for path in {
            path: None
            for inputs in [table.inputs for table in p.tables.values()] + [WCWIDTH_INPUTS]
            for path in inputs
            if path.startswith("contrib/unicode/")
        }
    ]
    generator_inputs = ["libcpp/" + table.generator for table in p.tables.values()] + [
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
    ] + unicode + [
        "gcc/gengtype-lex.l",
        "gcc/genmatch" + p.suffix,
    ] + ["gcc/cp/" + name + ".gperf" for name in p.gperf] + [
        "gcc/gen-pass-instances.awk",
        "gcc/passes.def",
        "gcc/config/i386/i386-passes.def",
        "gcc/config/i386/i386-builtin-types.awk",
        "gcc/config/i386/i386-builtin-types.def",
    ]

    # Shipped generated files are comparison fixtures, never compiler inputs.
    fixtures = ["libcpp/" + table.header for table in p.tables.values()] + [
        "libcpp/generated_cpp_wcwidth.h",
        "libdecnumber/decDPD.h",
        "libdecnumber/bid/bid2dpd_dpd2bid.h",
        "gcc/gengtype-lex" + p.suffix,
    ] + ["gcc/cp/" + name + ".h" for name in p.gperf]

    library_files = [path for library in p.extra_libraries.values() for path in library.files]
    untar(
        name = p.source[1:],
        decompress = "cellar//bootstrap/stage0-posix/mescc-tools-extra:unxz",
        files = SOURCE_DIRECTORIES + generator_inputs + fixtures + p.sources.libcpp_files + p.sources.libdecnumber_files + library_files + p.sources.compiler_files + p.sources.gcc_files + LICENSES + [library.license for library in p.extra_libraries.values()],
        flags = ["-x"],
        input = ":gcc-" + p.version + ".tar.xz",
        only = sorted(EXTRACTED + list(p.extra_libraries) + {path.partition("/")[0]: None for path in p.sources.compiler_files}.keys()),
        skip = SKIPPED + skip,
        # GCC archives use pax records, including for long member names.
        untar = "cellar//bootstrap/stage1/pax:untar",
    )

# generators/wcwidth.c's inputs after the Unicode version.
WCWIDTH_INPUTS = [
    "contrib/unicode/UnicodeData.txt",
    "contrib/unicode/EastAsianWidth.txt",
    "contrib/unicode/PropList.txt",
]

def _host_compiler(p):
    # The host release's final stage and C++ library build stage1.
    gcc_compiler(
        name = p.host_name + "-g++",
        binutils = p.binutils,
        command = p.host_libstdcxx + ":stage3-g++",
        sysroot = p.host + ":stage3-runtime",
    )

    # The previous stage's C++ compiler and library build the next stage.
    [
        gcc_compiler(
            name = stage + "-host-g++",
            binutils = p.binutils,
            command = p.libstdcxx + ":" + stage + "-g++",
            sysroot = ":" + stage + "-runtime",
        )
        for stage in PREDECESSOR.values()
    ]

# Flags for the table generators, by language.
GENERATOR_FLAGS = {
    "c": [
        "-O2",
        "-std=gnu99",
        "-Werror",
    ],
    "c++": [
        "-O2",
        "-Werror",
        "-fno-exceptions",
    ],
}

def _extension(language):
    return ".cc" if language == "c++" else ".c"

def _tables(p, unicode_version):
    # Each stage's generators rewrite libcpp's Unicode tables, libiberty's CRC
    # table and libdecnumber's DPD and BID tables. Every one must match the
    # release's shipped copy.
    [
        generate(
            name = name,
            args = args + [_location(p, "libiberty/crc32.c")],
            capture = True,
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
        name = "makeucnid" + p.suffix,
        src = p.source + "[libcpp/makeucnid" + p.suffix + "]",
        after = "\tif (i == NUM_CODE_POINTS) break;\n\tlast_flag = flags[i];",
        before = "\tlast_flag = flags[i];",
        output = "makeucnid" + p.suffix,
    )

    export_file(name = "generators/wcwidth.c")

    filegroup(
        name = "generator-source",
        srcs = {table.generator: ":" + table.generator for table in p.tables.values()} | {
            "crc-generator.c": ":crc-generator.c",
            "decDPD.c": GCC47 + ":generators/decDPD.c",
            "wcwidth.c": ":generators/wcwidth.c",
        },
    )

    [
        [
            c_object(
                name = stage + "-gen-" + name + ".o",
                src = ":generator-source[" + name + _extension(language) + "]",
                flags = GENERATOR_FLAGS[language],
                logical_source = name + _extension(language),
                source_tree = ":generator-source",
                toolchain = p.host_cxx[stage] if language == "c++" else p.host_cc[stage],
            ),
            _host_program(
                p,
                name = stage + "-gen-" + name,
                language = language,
                objects = [":" + stage + "-gen-" + name + ".o"],
                stage = stage,
            ),
        ]
        for stage in STAGES
        for name, language in p.generator_programs.items()
    ]

    [
        [
            generate(
                name = stage + "-" + table.header,
                args = [_location(p, source) for source in table.inputs],
                capture = True,
                output = table.header,
                tool = ":" + stage + "-gen-" + table.generator.rpartition(".")[0],
            )
            for table in p.tables.values()
        ] + [
            generate(
                name = stage + "-generated_cpp_wcwidth.h",
                args = [unicode_version] + [_location(p, source) for source in WCWIDTH_INPUTS],
                capture = True,
                output = "generated_cpp_wcwidth.h",
                tool = ":" + stage + "-gen-wcwidth",
            ),
            generate(
                name = stage + "-crc-table.c",
                capture = True,
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
                capture = True,
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
        compare_test(
            name = stage + "-" + name + "-regeneration",
            actual = ":" + stage + "-" + generated,
            expected = p.source + "[" + fixture + "]",
        )
        for stage in STAGES
        for name, generated, fixture in [
            (name, table.header, "libcpp/" + table.header)
            for name, table in p.tables.items()
        ] + [
            ("wcwidth", "generated_cpp_wcwidth.h", "libcpp/generated_cpp_wcwidth.h"),
            ("crc", "crc32.c", "libiberty/crc32.c"),
        ]
    ]

    # The DPD generator, preamble and BID generator are shared with GCC 4.7;
    # the tables are unchanged. Values are compared, so updated notices do not
    # matter.
    [
        [
            filegroup(
                name = "decimal-" + kind,
                srcs = {
                    "decDPD.h": header,
                    "decDPDSymbols.h": p.source + "[libdecnumber/decDPDSymbols.h]",
                },
            ),
            c_object(
                name = "decimal-" + kind + ".o",
                src = SHARED + ":tests/decimal-tables.c",
                flags = [
                    "-O2",
                    "-Werror",
                ],
                headers = [":decimal-" + kind],
                includes = [":decimal-" + kind],
                toolchain = p.host_cc["stage1"],
            ),
            _host_program(
                p,
                name = "decimal-" + kind + "-program",
                objects = [":decimal-" + kind + ".o"],
                stage = "stage1",
            ),
            generate(
                name = "decimal-" + kind + "-values",
                capture = True,
                tool = ":decimal-" + kind + "-program",
            ),
        ]
        for kind, header in [(
            stage + "-regenerated",
            ":" + stage + "-decDPD.h",
        ) for stage in STAGES] + [
            ("fixture", p.source + "[libdecnumber/decDPD.h]"),
        ]
    ]

    [compare_test(
        name = stage + "-decimal-regeneration",
        actual = ":decimal-" + stage + "-regenerated-values",
        expected = ":decimal-fixture-values",
    ) for stage in STAGES]

    generate(
        name = "bid-preamble",
        args = [
            "/^static const UINT128 reciprocals10_128/,$d",
            _location(p, "libdecnumber/bid/bid2dpd_dpd2bid.h"),
        ],
        capture = True,
        tool = SED,
    )

    [
        [
            filegroup(
                name = stage + "-bid-generator-source",
                srcs = {
                    "bid-tables.c": GCC47 + ":generators/bid-tables.c",
                    "decDPD.h": ":" + stage + "-decDPD.h",
                    "decDPDSymbols.h": p.source + "[libdecnumber/decDPDSymbols.h]",
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
                source_tree = ":" + stage + "-bid-generator-source",
                toolchain = p.host_cc[stage],
            ),
            _host_program(
                p,
                name = stage + "-gen-bid",
                libraries = ["cellar//bootstrap/stage1/gmp:libgmp.a"],
                objects = [":" + stage + "-gen-bid.o"],
                stage = stage,
            ),
            generate(
                name = stage + "-bid-tables",
                capture = True,
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
                src = SHARED + ":tests/bid-tables.c",
                flags = [
                    "-O2",
                    "-Werror",
                ],
                includes = [":bid-" + kind],
                toolchain = p.host_cc["stage1"],
            ),
            _host_program(
                p,
                name = "bid-" + kind + "-program",
                objects = [":bid-" + kind + ".o"],
                stage = "stage1",
            ),
            generate(
                name = "bid-" + kind + "-values",
                capture = True,
                tool = ":bid-" + kind + "-program",
            ),
        ]
        for kind, header in [(
            stage + "-regenerated",
            ":" + stage + "-bid2dpd_dpd2bid.h",
        ) for stage in STAGES] + [
            ("fixture", p.source + "[libdecnumber/bid/bid2dpd_dpd2bid.h]"),
        ]
    ]

    [compare_test(
        name = stage + "-bid-regeneration",
        actual = ":bid-" + stage + "-regenerated-values",
        expected = ":bid-fixture-values",
    ) for stage in STAGES]

# Reviewed native LP64 GCC/musl features for libiberty, libcpp and
# libdecnumber; no NLS, host obstacks or tuning probes. Each release adds its
# LIBRARY_CONFIG_VALUES.
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

# Support library sources the port replaces with regenerated or patched
# copies under build/.
LIBRARY_BUILD_SOURCES = [
    "libiberty/crc32",
    "libiberty/make-temp-file",
]

LANGUAGE_FLAGS = {
    "c": [],
    # GCC's host code needs no exceptions or RTTI. Like upstream, each stage
    # keeps its compiler's default C++ dialect.
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

def _support_libraries(p, tmpdir_patch):
    # libiberty, libcpp, libdecnumber, libbacktrace and the release's extra
    # support libraries, compiled by each stage's host compilers.
    write_file(
        name = "library-config.h",
        content = "#ifndef GCC{0}_LIBRARY_CONFIG_H\n#define GCC{0}_LIBRARY_CONFIG_H 1\n#ifndef _GNU_SOURCE\n#define _GNU_SOURCE 1\n#endif\n".format(p.major) + "\n".join(["#define " + name + " 1" for name in LIBRARY_CONFIG_ON]) + "\n" + "\n".join(["#define " + name + " " + value for name, value in p.config.library_config_values.items()]) + "\n#endif\n",
    )

    write_file(
        name = "backtrace-config.h",
        content = "#ifndef _GNU_SOURCE\n#define _GNU_SOURCE 1\n#endif\n" + "\n".join(["#define " + name + " 1" for name in BACKTRACE_CONFIG_ON]) + "\n" + "".join(["#define HAVE_DECL_" + name + " 1\n" for name in p.config.backtrace_declarations]) + "#define BACKTRACE_ELF_SIZE 64\n#define SIZEOF_CHAR 1\n#define SIZEOF_INT 4\n#define SIZEOF_LONG 8\n#define SIZEOF_SHORT 2\n#define SIZEOF_VOID_P 8\n",
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
            _location(p, "libbacktrace/backtrace-supported.h.in"),
        ],
        capture = True,
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

    exact_patch(
        name = "make-temp-file.c",
        src = p.source + "[libiberty/make-temp-file.c]",
        output = "make-temp-file.c",
        patch = tmpdir_patch,
    )

    # Shipped sources are projected whole where no sibling includes a
    # regenerated file. Build-only headers and replacement sources live under
    # build/.
    [
        filegroup(
            name = stage + "-library-source",
            srcs = {path: p.source + "[" + path + "]" for path in p.sources.libcpp_files + p.sources.libdecnumber_files + [path for library in p.extra_libraries.values() for path in library.files]} | {
                "gcc/config/i386/cpuid.h": p.source + "[gcc/config/i386/cpuid.h]",
                "include": p.source + "[include]",
                "libiberty": p.source + "[libiberty]",
                "libbacktrace": p.source + "[libbacktrace]",
                "libcpp/config.h": ":library-config.h",
                "libcpp/localedir.h": ":localedir.h",
            } | {"libcpp/" + table.header: ":" + stage + "-" + table.header for table in p.tables.values()} | {
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
                "build/libbacktrace/unwind.h": p.source + "[libgcc/unwind-generic.h]",
            } | {"build/" + name + "/config.h": library.config for name, library in p.extra_libraries.items()},
        )
        for stage in STAGES
    ]

    [
        c_object(
            name = stage + "-" + name + "-" + source.replace("/", "-") + ".o",
            src = ":" + stage + "-library-source",
            defines = library.defines + library.object_defines.get(source, []),
            flags = LANGUAGE_FLAGS[library.language] + [
                "-O2",
                "-Werror",
            ] + library.flags,
            logical_includes = library.includes,
            logical_source = ("build/" if name + "/" + source in LIBRARY_BUILD_SOURCES else "") + name + "/" + source + library.suffix,
            object_name = name + str(i) + ".o",
            source_tree = ":" + stage + "-library-source",
            toolchain = p.host_cxx[stage] if library.language == "c++" else p.host_cc[stage],
        )
        for stage in STAGES
        for name, library in p.libraries.items()
        for i, source in enumerate(library.objects)
    ]

    [
        c_library(
            name = stage + "-" + name + ".a",
            objects = [":" + stage + "-" + name + "-" + source.replace("/", "-") + ".o" for source in library.objects],
            output = name + ".a",
            toolchain = p.host_cc[stage],
        )
        for stage in STAGES
        for name, library in p.libraries.items()
    ]

def _library_tests(p):
    [
        [
            c_object(
                name = name + "-test.o",
                src = SHARED + ":tests/" + source,
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
                toolchain = p.host_cxx["stage1"] if language == "c++" else p.host_cc["stage1"],
            ),
            _host_program(
                p,
                name = name + "-test-bin",
                language = language,
                libraries = [
                    ":stage1-libcpp.a",
                    ":stage1-libiberty.a",
                    ":stage1-libdecnumber.a",
                ],
                objects = [":" + name + "-test.o"],
                stage = "stage1",
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
        chdir = True,
        directory = True,
        env = {"TMPDIR": "."},
        files = ["passed"],
        tool = ":libiberty-test-bin",
    )

    result_test(
        name = "libiberty-temp",
        result = ":libiberty-temp-run[passed]",
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
            "input.c": GCC40 + ":cpp-input.c",
            "included.h": GCC40 + ":included.h",
        },
    )

    generate(
        name = "cpp-result",
        args = ["$(location :cpp-fixtures[input.c])"],
        capture = True,
        inputs = [":cpp-fixtures"],
        tool = ":cpp-test-bin",
    )

    compare_test(
        name = "cpp-tokens",
        actual = ":cpp-result",
        expected = GCC40 + ":cpp-expected",
    )

    command_test(
        name = "cpp-missing-include",
        args = [
            "1",
            "$(exe :cpp-test-bin)",
            "$(location " + GCC40 + ":cpp-bad.c)",
        ],
        tool = EXPECT_EXIT,
    )

def _gengtype_scanner(p):
    # gengtype's scanner is regenerated with the bootstrapped Flex 2.6.4,
    # which also produced the shipped copy. Upstream prefixes the
    # configuration include.
    scanner = "gengtype-lex" + p.suffix
    filegroup(
        name = "gengtype-scanner-source",
        srcs = {"gengtype-lex.l": p.source + "[gcc/gengtype-lex.l]"},
    )

    generate(
        name = "gengtype-scanner",
        args = [
            "-o" + scanner,
            "source/gengtype-lex.l",
        ],
        chdir = True,
        directory = True,
        files = [scanner],
        source_tree = ":gengtype-scanner-source",
        tool = "cellar//bootstrap/stage1/flex-final:flex",
    )

    write_file(
        name = "gengtype-lex-prefix",
        content = '#ifdef HOST_GENERATOR_FILE\n#include "config.h"\n#else\n#include "bconfig.h"\n#endif\n',
    )

    concatenate(
        name = scanner,
        inputs = [
            ":gengtype-lex-prefix",
            ":gengtype-scanner[" + scanner + "]",
        ],
        output = scanner,
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
            capture = True,
            tool = SED,
        )
        for kind, source in [
            ("regenerated", ":" + scanner),
            ("fixture", p.source + "[gcc/" + scanner + "]"),
        ]
    ]

    compare_test(
        name = "gengtype-scanner-regeneration",
        actual = ":gengtype-lex-regenerated.normalized",
        expected = ":gengtype-lex-fixture.normalized",
    )

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

# gcc/mkconfig.sh output for config.gcc's x86_64-*-linux*musl* target files.
TM_DEFINES = [
    ("LIBC_GLIBC", "1"),
    ("LIBC_UCLIBC", "2"),
    ("LIBC_BIONIC", "3"),
    ("LIBC_MUSL", "4"),
    ("DEFAULT_LIBC", "LIBC_MUSL"),
    ("ANDROID_DEFAULT", "0"),
]

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

def _configuration(p):
    config = p.config

    # Macros already set by library-config.h are omitted.
    write_file(
        name = "auto-host.h",
        content = "".join(["#define " + name + " 1\n" for name in GCC_TARGET_CONFIG]) + '#ifndef USED_FOR_TARGET\n#include "library-config.h"\n' + "".join(["#define " + name + " 1\n" for name in config.gcc_config_on if name not in GCC_TARGET_CONFIG]) + "".join(["#define " + name + " " + value + "\n" for name, value in config.gcc_config_values.items() if name not in GCC_TARGET_CONFIG]) + "#endif\n",
    )

    write_file(
        name = "tm.h",
        content = _mkconfig(
            "GCC_TM_H",
            [
                "options.h",
                "insn-constants.h",
            ] + ["config/" + name for name in config.tm_files],
            after = '#if defined IN_GCC && !defined GENERATOR_FILE && !defined USED_FOR_TARGET\n# include "insn-flags.h"\n#endif\n#if defined IN_GCC && !defined GENERATOR_FILE\n# include "insn-modes.h"\n#endif\n# include "defaults.h"\n' + config.tm_epilogue,
            defines = TM_DEFINES,
        ),
    )

    write_file(
        name = "tm_p.h",
        content = _mkconfig(
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
            content = _mkconfig(
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

    # Numbered pass instances, including the x86 passes from i386/t-i386.
    generate(
        name = "pass-instances.def",
        args = [
            "-f",
            _location(p, "gcc/gen-pass-instances.awk"),
            _location(p, "gcc/passes.def"),
            _location(p, "gcc/config/i386/i386-passes.def"),
        ],
        capture = True,
        output = "pass-instances.def",
        tool = GAWK,
    )

    generate(
        name = "i386-builtin-types.inc",
        args = [
            "-f",
            _location(p, "gcc/config/i386/i386-builtin-types.awk"),
            _location(p, "gcc/config/i386/i386-builtin-types.def"),
        ],
        capture = True,
        output = "i386-builtin-types.inc",
        tool = GAWK,
    )

    # opt-gather.awk compares records as strings; LC_ALL=C fixes their order.
    generate(
        name = "optionlist",
        args = [
            "-f",
            _location(p, "gcc/opt-gather.awk"),
        ] + [_location(p, path) for path in OPTION_FILES],
        capture = True,
        env = {"LC_ALL": "C"},
        tool = GAWK,
    )

    [
        generate(
            name = output,
            args = [
                "-f",
                _location(p, "gcc/opt-functions.awk"),
                "-f",
                _location(p, "gcc/opt-read.awk"),
                "-f",
                _location(p, "gcc/" + script),
            ] + ([
                "-v",
                "header_name=" + headers,
            ] if headers else []),
            capture = True,
            output = output,
            stdin = ":optionlist",
            tool = GAWK,
        )
        for output, script, headers in [
            ("options.h", "opth-gen.awk", ""),
            ("options" + p.suffix, "optc-gen.awk", "config.h system.h coretypes.h options.h tm.h"),
            ("options-save" + p.suffix, "optc-save-gen.awk", "config.h system.h coretypes.h tm.h"),
        ]
    ]

    write_file(
        name = "all-tree.def",
        content = '#include "tree.def"\nEND_OF_BASE_TREE_CODES\n#include "c-family/c-common.def"\n#include "cp/cp-tree.def"\n',
    )

    major, minor, patchlevel = p.version.split(".")
    write_file(
        name = "bversion.h",
        content = "#define BUILDING_GCC_MAJOR {}\n#define BUILDING_GCC_MINOR {}\n#define BUILDING_GCC_PATCHLEVEL {}\n#define BUILDING_GCC_VERSION (BUILDING_GCC_MAJOR * 1000 + BUILDING_GCC_MINOR)\n".format(major, minor, patchlevel),
    )

def _generated_sources(p):
    # genmatch resolves match.pd's include of the generated cfn-operators.pd
    # from its working directory. Name that directory "." rather than its
    # absolute action path, which would otherwise be recorded in the
    # generated sources.
    exact_patch(
        name = "genmatch" + p.suffix,
        src = p.source + "[gcc/genmatch" + p.suffix + "]",
        after = "  dir->name = ASTRDUP (\".\");\n  cpp_set_include_chains",
        before = "  dir->name = getpwd ();\n  if (!dir->name)\n    dir->name = ASTRDUP (\".\");\n  cpp_set_include_chains",
        output = "genmatch" + p.suffix,
    )

    if not p.genversion:
        # The generated header's comment names the generator, not its action
        # path, as in the GCC 4.7 port.
        exact_patch(
            name = "gcov-iov.c",
            src = p.source + "[gcc/gcov-iov.c]",
            output = "gcov-iov.c",
            patch = GCC47 + ":patches/gcov-program.patch",
        )

    # gperf writes these lookups upstream. generators/gperf.awk writes an
    # equivalent sorted table and bisecting lookup from the same input with
    # the bootstrapped awk, with the lookup function gperf's -N option names.
    [
        generate(
            name = name + ".h",
            args = [
                "-v",
                "lookup=" + table.lookup,
                "-f",
                "$(location " + SHARED + ":generators/gperf.awk)",
                _location(p, "gcc/cp/" + name + ".gperf"),
            ],
            capture = True,
            output = name + ".h",
            tool = GAWK,
        )
        for name, table in p.gperf.items()
    ]

    # Each regenerated table must agree with gperf's shipped lookup, including
    # for every name in the shipped word list.
    [
        [
            filegroup(
                name = name + "-" + kind,
                srcs = {name + ".h": header},
            )
            for kind, header in [
                (
                    "generated",
                    ":" + name + ".h",
                ),
                (
                    "shipped",
                    p.source + "[gcc/cp/" + name + ".h]",
                ),
            ]
        ] + [
            generate(
                name = name + "-shipped-names.h",
                args = [
                    "-n",
                    "-e",
                    's/^ *{\\("[^"]*"\\),.*$/\\1,/p',
                    _location(p, "gcc/cp/" + name + ".h"),
                ],
                capture = True,
                tool = SED,
            ),
            filegroup(
                name = name + "-names",
                srcs = {"shipped-names.h": ":" + name + "-shipped-names.h"},
            ),
        ] + [
            c_object(
                name = name + "-" + kind + ".o",
                src = table.tests + "lookup.cc",
                defines = [
                    table.prefix + "_NAMESPACE=" + kind,
                    table.prefix + "_LOOKUP=" + kind + "_lookup",
                ] + ([table.prefix + "_TABLE=1"] if kind == "generated" else []),
                flags = [
                    "-O2",
                    "-Werror",
                ],
                headers = [":" + name + "-" + kind],
                includes = [":" + name + "-" + kind],
                toolchain = p.host_cxx["stage1"],
            )
            for kind in [
                "generated",
                "shipped",
            ]
        ] + [
            c_object(
                name = name + "-main.o",
                src = table.tests + "main.cc",
                flags = [
                    "-O2",
                    "-Werror",
                ],
                headers = [":" + name + "-names"],
                includes = [":" + name + "-names"],
                toolchain = p.host_cxx["stage1"],
            ),
            _host_program(
                p,
                name = name + "-test-bin",
                language = "c++",
                objects = [
                    ":" + name + "-main.o",
                    ":" + name + "-generated.o",
                    ":" + name + "-shipped.o",
                ],
                stage = "stage1",
            ),
            command_test(
                name = name + "-lookup",
                tool = ":" + name + "-test-bin",
            ),
        ]
        for name, table in p.gperf.items()
    ]

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

# Build objects most generators link.
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

MD_FILES = [
    "common.md",
    "config/i386/i386.md",
]

def _version_defines(p):
    # A release has no date or revision in its version string.
    return [
        'BASEVER="' + p.version + '"',
        'DATESTAMP=""',
        'DEVPHASE=""',
        'REVISION=""',
        'PKGVERSION="(Cellar bootstrap) "',
        'BUGURL="<https://gcc.gnu.org/bugs/>"',
    ]

def _gcc_tree(p):
    """The sources and configuration every generator and compiler stage shares.

    The gcc/, libcpp/ and include/ trees, with the regenerated sources and
    configuration headers in their places.
    """

    # Configuration shared by every generator and compiler stage.
    config_overlay = {"build/gcc/" + name: ":" + name for name in [
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
        "options" + p.suffix,
        "options-save" + p.suffix,
        "pass-instances.def",
        "i386-builtin-types.inc",
    ]}
    return {path: p.source + "[" + path + "]" for path in p.sources.gcc_files + p.sources.libcpp_files + [path for library in p.extra_libraries.values() for path in library.files] + p.sources.compiler_files} | {
        "include": p.source + "[include]",
        "gcc/gengtype-lex" + p.suffix: ":gengtype-lex" + p.suffix,
        "gcc/genmatch" + p.suffix: ":genmatch" + p.suffix,
    } | {"gcc/cp/" + name + ".h": ":" + name + ".h" for name in p.gperf} | ({} if p.genversion else {
        "gcc/gcov-iov.c": ":gcov-iov.c",
    }) | config_overlay

def _generator_outputs(p):
    """Generator outputs, by the layer that first provides them.

    Each layer's tree holds everything earlier layers generated, in gcc's
    objdir under build/gcc. Each output is (output, generator, arguments).
    """
    s = p.suffix
    modes = [
        ("insn-modes" + s, "genmodes", []),
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
            "min-insn-modes" + s,
            "genmodes",
            ["-m"],
        ),
        ("genrtl.h", "gengenrtl", []),
    ] + ([("version.h", "genversion", [])] if p.genversion else [])
    constants = [
        ("insn-constants.h", "genconstants", []),
        ("insn-enums" + s, "genenums", []),
    ]
    predicates = [
        ("insn-preds" + s, "genpreds", []),
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
        ("gencondmd" + s, "genconditions", []),
    ]
    hooks = [
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
    return modes, constants, predicates, hooks

def _md_outputs(p):
    """Machine-description outputs, read with insn-conditions.md."""
    s = p.suffix
    return [
        ("insn-attr.h", "genattr"),
        ("insn-attr-common.h", "genattr-common"),
        ("insn-codes.h", "gencodes"),
        ("insn-config.h", "genconfig"),
        ("insn-flags.h", "genflags"),
        ("insn-target-def.h", "gentarget-def"),
        ("insn-automata" + s, "genautomata"),
        ("insn-emit" + s, "genemit"),
        ("insn-extract" + s, "genextract"),
        ("insn-output" + s, "genoutput"),
        ("insn-peep" + s, "genpeep"),
        ("insn-recog" + s, "genrecog"),
    ]

def _generated_layers(p):
    """The generator outputs each layer's tree adds, by target name.

    Each tree adds the previous layers' outputs, named by their targets
    without the stage prefix.
    """
    modes, constants, predicates, hooks = _generator_outputs(p)
    return [
        {output: output.replace("/", "-") for output, tool, args in modes},
        {output: output.replace("/", "-") for output, tool, args in constants} |
        {output: "gtype-output[" + output + "]" for output in p.sources.gtype_outputs},
        {output: output.replace("/", "-") for output, tool, args in predicates},
        {output: output.replace("/", "-") for output, tool, args in hooks} | {
            "insn-conditions.md": "insn-conditions.md",
        },
    ]

def _generators(p):
    gcc_tree = _gcc_tree(p)
    layers = _generated_layers(p)
    [
        filegroup(
            name = stage + "-generator-tree" + str(layer),
            srcs = gcc_tree | {
                "build/gcc/" + output: ":" + stage + "-" + target
                for outputs in layers[:layer]
                for output, target in outputs.items()
            },
        )
        for stage in STAGES
        for layer in range(len(layers) + 1)
    ]

    generated_sources = [
        "min-insn-modes",
        "gencondmd",
    ]
    [
        c_object(
            name = stage + "-build-" + name + ".o",
            src = ":" + stage + "-generator-tree" + str(layer),
            defines = GENERATOR_DEFINES + (_version_defines(p) if name in ["genversion", "version"] else []),
            flags = LANGUAGE_FLAGS["c++"] + [
                "-O2",
                "-Werror",
            ],
            logical_includes = GENERATOR_INCLUDES,
            logical_source = ("build/gcc/" + name + p.suffix) if name in generated_sources else _gcc_source(p, name),
            object_name = name + ".o",
            source_tree = ":" + stage + "-generator-tree" + str(layer),
            toolchain = p.host_cxx[stage],
        )
        for stage in STAGES
        for name, layer in p.generator_objects.items()
    ]

    generators = {
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
        ] + ([] if p.genversion else ["version"]),
        "gencheck": ["gencheck"],
        "genchecksum": ["genchecksum"],
        "genmatch": [
            "genmatch",
            "errors",
            "vec",
            "hash-table",
            "sort",
        ],
    } | ({"genversion": ["genversion"]} if p.genversion else {"gcov-iov": ["gcov-iov"]})

    [
        _host_program(
            p,
            name = stage + "-" + name,
            language = "c++",
            libraries = ([":" + stage + "-libcpp.a"] if name == "genmatch" else []) + [":" + stage + "-libiberty.a"],
            objects = [":" + stage + "-build-" + obj + ".o" for obj in objects],
            stage = stage,
        )
        for stage in STAGES
        for name, objects in generators.items()
    ]

    # Outputs written to standard output. Machine-description readers run in
    # gcc/ so the file names they record are the stable relative spellings.
    modes, constants, predicates, hooks = _generator_outputs(p)
    [
        generate(
            name = stage + "-" + output.replace("/", "-"),
            args = args + (MD_FILES if tool.startswith("gen") and tool not in [
                "genmodes",
                "gengenrtl",
                "gencheck",
                "genhooks",
                "gencfn-macros",
                "genversion",
            ] else []),
            capture = True,
            output = output.replace("/", "-"),
            tool = ":" + stage + "-" + tool,
            working_directory = ":" + stage + "-generator-tree" + str(layer) + "[gcc]",
        )
        for stage in STAGES
        for layer, outputs in [
            (0, modes),
            (1, constants),
            (2, predicates),
            (2, hooks),
        ]
        for output, tool, args in outputs
    ]

    [
        generate(
            name = stage + "-insn-conditions.md",
            capture = True,
            output = "insn-conditions.md",
            tool = ":" + stage + "-gencondmd",
        )
        for stage in STAGES
    ]

    [
        generate(
            name = stage + "-" + output,
            args = MD_FILES + ["../build/gcc/insn-conditions.md"],
            capture = True,
            # The conditions lie outside gcc/, so the whole tree is an input;
            # remote workers receive only the declared paths.
            inputs = [":" + stage + "-generator-tree4"],
            output = output,
            tool = ":" + stage + "-" + tool,
            working_directory = ":" + stage + "-generator-tree4[gcc]",
        )
        for stage in STAGES
        for output, tool in _md_outputs(p)
    ]

    # genattrtab and genopinit write several named files.
    s = p.suffix
    [
        generate(
            name = stage + "-" + tool + "-outputs",
            args = ["source/gcc/" + path for path in MD_FILES] + [
                "source/build/gcc/insn-conditions.md",
            ] + args,
            chdir = True,
            directory = True,
            files = files,
            source_tree = ":" + stage + "-generator-tree4",
            tool = ":" + stage + "-" + tool,
        )
        for stage in STAGES
        for tool, args, files in [
            (
                "genattrtab",
                [
                    "-Ainsn-attrtab" + s,
                    "-Dinsn-dfatab" + s,
                    "-Linsn-latencytab" + s,
                ],
                [
                    "insn-attrtab" + s,
                    "insn-dfatab" + s,
                    "insn-latencytab" + s,
                ],
            ),
            (
                "genopinit",
                [
                    "-hinsn-opinit.h",
                    "-cinsn-opinit" + s,
                ],
                [
                    "insn-opinit.h",
                    "insn-opinit" + s,
                ],
            ),
        ]
    ]

    # genmatch finds match.pd's generated cfn-operators.pd in its working
    # directory, the objdir that holds it.
    [
        generate(
            name = stage + "-" + kind + "-match" + s,
            args = [
                "--" + kind,
                "../../gcc/match.pd",
            ],
            capture = True,
            # match.pd lies outside build/gcc, so the whole tree is an input.
            inputs = [":" + stage + "-generator-tree4"],
            output = kind + "-match" + s,
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
            for path in p.sources.gtype_inputs
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
            chdir = True,
            directory = True,
            files = ["gtype.state"],
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
            chdir = True,
            directory = True,
            files = p.sources.gtype_outputs,
            source_tree = ":" + stage + "-generator-tree0",
            tool = ":" + stage + "-gengtype",
        )
        for stage in STAGES
    ]

    if not p.genversion:
        [
            generate(
                name = stage + "-gcov-iov.h",
                args = [
                    p.version,
                    "",
                ],
                capture = True,
                output = "gcov-iov.h",
                tool = ":" + stage + "-gcov-iov",
            )
            for stage in STAGES
        ]

COMPILER_DEFINES = [
    "_GNU_SOURCE=1",
    "IN_GCC=1",
    "HAVE_CONFIG_H=1",
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

def _compiler_trees(p):
    """Each stage's compiler tree.

    The shared sources with every generator output of that stage.
    """
    s = p.suffix
    md_tree = {output: output for output, tool in _md_outputs(p)} | {
        "insn-attrtab" + s: "genattrtab-outputs[insn-attrtab" + s + "]",
        "insn-dfatab" + s: "genattrtab-outputs[insn-dfatab" + s + "]",
        "insn-latencytab" + s: "genattrtab-outputs[insn-latencytab" + s + "]",
        "insn-opinit.h": "genopinit-outputs[insn-opinit.h]",
        "insn-opinit" + s: "genopinit-outputs[insn-opinit" + s + "]",
        "gimple-match" + s: "gimple-match" + s,
        "generic-match" + s: "generic-match" + s,
    } | ({} if p.genversion else {"gcov-iov.h": "gcov-iov.h"})
    gcc_tree = _gcc_tree(p)
    return {stage: gcc_tree | {
        "build/gcc/" + output: ":" + stage + "-" + target
        for outputs in _generated_layers(p) + [md_tree]
        for output, target in outputs.items()
    } | {"build/gcc/" + name: ":" + name for name in [
        "configargs.h",
        "multilib.h",
        "specs.h",
        "omp-device-properties.h",
    ]} | {path: p.source + "[" + path + "]" for path in p.sources.libdecnumber_files} | {
        "libdecnumber/config.h": ":library-config.h",
        "libdecnumber/gstdint.h": ":gstdint.h",
        "libdecnumber/decDPD.h": ":" + stage + "-decDPD.h",
        "libdecnumber/bid/bid2dpd_dpd2bid.h": ":" + stage + "-bid2dpd_dpd2bid.h",
        "libbacktrace/backtrace.h": p.source + "[libbacktrace/backtrace.h]",
        "build/libbacktrace/backtrace-supported.h": ":backtrace-supported.h",
        "gmp": "cellar//bootstrap/stage1/gmp:headers",
        "mpfr": "cellar//bootstrap/stage1/mpfr:headers",
        "mpc": "cellar//bootstrap/stage1/mpc:headers",
        "zlib": p.binutils + ":zlib-source[zlib]",
    } for stage in STAGES}

def _object_defines(p):
    """gcc/Makefile.in CFLAGS-<object> additions."""
    basever = 'BASEVER="' + p.version + '"'
    preprocessor = [
        'GCC_INCLUDE_DIR="' + GCC_PREFIX + '/include"',
        'GPLUSPLUS_INCLUDE_DIR="/include/c++/' + p.version + '"',
        "GPLUSPLUS_INCLUDE_DIR_ADD_SYSROOT=1",
        'GPLUSPLUS_TOOL_INCLUDE_DIR="/include/c++/' + p.version + "/" + TARGET + '"',
        'GPLUSPLUS_BACKWARD_INCLUDE_DIR="/include/c++/' + p.version + '/backward"',
        'NATIVE_SYSTEM_HEADER_DIR="/include"',
        'PREFIX="' + GCC_PREFIX + '/"',
        'STANDARD_EXEC_PREFIX="' + GCC_PREFIX + '/lib/gcc/"',
        'TARGET_SYSTEM_ROOT="' + SYSROOT + '"',
    ]
    driver = [
        'STANDARD_STARTFILE_PREFIX="/lib/"',
        'STANDARD_STARTFILE_PREFIX_1=""',
        'STANDARD_STARTFILE_PREFIX_2=""',
        'STANDARD_EXEC_PREFIX="' + GCC_PREFIX + '/lib/gcc/"',
        'STANDARD_LIBEXEC_PREFIX="' + GCC_PREFIX + '/libexec/gcc/"',
        'STANDARD_BINDIR_PREFIX="' + GCC_PREFIX + '/bin/"',
        'DEFAULT_TARGET_VERSION="' + p.version + '"',
        'DEFAULT_REAL_TARGET_MACHINE="' + TARGET + '"',
        'DEFAULT_TARGET_MACHINE="' + TARGET + '"',
        'TOOLDIR_BASE_PREFIX="../../../"',
        'ACCEL_DIR_SUFFIX=""',
        'TARGET_SYSTEM_ROOT="' + SYSROOT + '"',
        'CONFIGURE_SPECS=""',
        'NATIVE_SYSTEM_HEADER_DIR="/include"',
    ]
    return {
        "gcc": driver + [basever],
        "c/gccspec": driver,
        "cp/g++spec": driver,
        "prefix": [
            'PREFIX="' + GCC_PREFIX + '"',
            basever,
        ],
        "cppbuiltin": preprocessor + [basever],
        "cppdefault": preprocessor,
        "c-family/c-opts": ['TARGET_SYSTEM_ROOT="' + SYSROOT + '"'],
        "c-family/c-pch": [
            'HOST_MACHINE="' + TARGET + '"',
            'TARGET_MACHINE="' + TARGET + '"',
        ],
        "toplev": ['TARGET_NAME="' + TARGET + '"'],
        "optinfo-emit-json": ['TARGET_NAME="' + TARGET + '"'],
        "lto-streamer-in": ['TARGET_MACHINE="' + TARGET + '"'],
        "intl": ['LOCALEDIR="/nonexistent-bootstrap-locale"'],
    } | ({} if p.genversion else {"version": _version_defines(p)}) | p.config.object_defines

def _compiler_includes(p):
    return [
        "build/gcc",
        "gcc",
        "include",
        "libcpp/include",
    ] + [include for library in p.extra_libraries.values() for include in library.compiler_includes] + [
        "libdecnumber",
        "libdecnumber/bid",
        "libbacktrace",
        "build/libbacktrace",
        "gmp",
        "mpfr",
        "mpc",
        "zlib",
    ]

def _compiler_flags(stage):
    # Upstream's first stage accepts the older host compiler's warnings.
    return LANGUAGE_FLAGS["c++"] + ["-O2"] + ([] if stage == "stage1" else ["-Werror"])

def _compilers(p):
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

    compiler_trees = _compiler_trees(p)
    [
        filegroup(
            name = stage + "-compiler-tree",
            srcs = compiler_trees[stage],
        )
        for stage in STAGES
    ]

    object_defines = _object_defines(p)
    includes = _compiler_includes(p)
    frontend_objects = {name: None for name in p.sources.c_objects + p.sources.cxx_objects}
    [
        c_object(
            name = stage + "-cc-" + name.replace("/", "-") + ".o",
            src = ":" + stage + "-compiler-tree",
            defines = COMPILER_DEFINES + object_defines.get(name, []) + (["IN_GCC_FRONTEND=1"] if name in frontend_objects else []),
            flags = _compiler_flags(stage),
            logical_includes = includes[:2] + (["gcc/" + name.rpartition("/")[0]] if "/" in name else []) + includes[2:],
            logical_source = ("build/gcc/" + name + p.suffix) if name in p.sources.generated_compiler_sources else _gcc_source(p, name),
            object_name = "cc" + str(i) + ".o",
            source_tree = ":" + stage + "-compiler-tree",
            toolchain = p.host_cxx[stage],
        )
        for stage in STAGES
        for i, name in enumerate(p.compiler_object_names)
    ]

    [
        c_library(
            name = stage + "-" + library + ".a",
            objects = [":" + stage + "-cc-" + name.replace("/", "-") + ".o" for name in objects],
            output = library + ".a",
            toolchain = p.host_cc[stage],
        )
        for stage in STAGES
        for library, objects in [
            ("libbackend", p.sources.backend_objects),
            ("libcommon", p.sources.common_objects),
            ("libcommon-target", p.sources.common_target_objects),
        ]
    ]

    [
        c_object(
            name = stage + "-zlib-" + name + ".o",
            src = p.binutils + ":zlib-source[zlib/" + name + ".c]",
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
            source_tree = p.binutils + ":zlib-source",
            toolchain = p.host_cc[stage],
        )
        for stage in STAGES
        for i, name in enumerate(ZLIB_OBJECTS)
    ]

    [c_library(
        name = stage + "-libz.a",
        objects = [":" + stage + "-zlib-" + name + ".o" for name in ZLIB_OBJECTS],
        output = "libz.a",
        toolchain = p.host_cc[stage],
    ) for stage in STAGES]

    # Objects both compilers link, such as an allocator, each compiled by the
    # stage's host compiler.
    [
        declare(
            name = stage + "-" + name,
            toolchain = p.host_cc[stage],
        )
        for stage in STAGES
        for name, declare in p.compiler_objects.items()
    ]

    # c/Make-lang.in: $(BACKEND) $(LIBS) $(BACKENDLIBS). A front end's own
    # support libraries follow $(BACKEND).
    libraries = {(stage, frontend): [":" + stage + "-" + name + ".a" for name in [
        "libbackend",
        "libcommon-target",
        "libcommon",
        "libcpp",
        "libdecnumber",
    ] + [name for name, library in p.extra_libraries.items() if frontend in library.linked_by] + [
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
    ] for stage in STAGES for frontend in [
        "cc1",
        "cc1plus",
    ]}

    write_file(
        name = "checksum-options",
        content = "cellar native static compiler link; -O2 -g0 -frandom-seed=bootstrap; C,C++; no multilib, LTO, plugins or Graphite\n",
    )

    # genchecksum digests every object and library the compiler links, as
    # upstream's cc1-checksum.c does.
    [
        [
            generate(
                name = stage + "-" + frontend + "-checksum" + p.suffix,
                args = ["$(location :" + stage + "-cc-" + name.replace("/", "-") + ".o)" for name in objects] + [
                    "$(location :" + stage + "-cc-main.o)",
                ] + ["$(location :" + stage + "-" + name + ")" for name in p.compiler_objects] + ["$(location " + library + ")" for library in libraries[(stage, frontend)]] + [
                    "$(location :checksum-options)",
                ],
                capture = True,
                output = frontend + "-checksum" + p.suffix,
                tool = ":" + stage + "-genchecksum",
            ),
            filegroup(
                name = stage + "-" + frontend + "-checksum-source",
                srcs = compiler_trees[stage] | {"build/gcc/" + frontend + "-checksum" + p.suffix: ":" + stage + "-" + frontend + "-checksum" + p.suffix},
            ),
            c_object(
                name = stage + "-" + frontend + "-checksum.o",
                src = ":" + stage + "-" + frontend + "-checksum-source",
                defines = COMPILER_DEFINES + ["IN_GCC_FRONTEND=1"],
                flags = _compiler_flags(stage),
                logical_includes = includes,
                logical_source = "build/gcc/" + frontend + "-checksum" + p.suffix,
                source_tree = ":" + stage + "-" + frontend + "-checksum-source",
                toolchain = p.host_cxx[stage],
            ),
            _host_program(
                p,
                name = stage + "-" + frontend,
                language = "c++",
                libraries = libraries[(stage, frontend)],
                objects = [":" + stage + "-cc-" + name.replace("/", "-") + ".o" for name in objects] + [
                    ":" + stage + "-" + frontend + "-checksum.o",
                    ":" + stage + "-cc-main.o",
                ] + [":" + stage + "-" + name for name in p.compiler_objects],
                output = frontend,
                stage = stage,
            ),
        ]
        for stage in STAGES
        for frontend, objects in [
            ("cc1", p.sources.c_objects),
            ("cc1plus", p.sources.cxx_objects),
        ]
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

DRIVER_LIBRARIES = [
    "libcommon-target",
    "libcommon",
    "libcpp",
    "libbacktrace",
    "libiberty",
    "libdecnumber",
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

def _driver(p, lookup):
    # A compiler, assembler or linker the driver cannot find beside itself is
    # an error, rather than a program to search for on the host PATH.
    driver = "gcc" + p.suffix
    exact_patch(
        name = "driver-tool" + p.suffix,
        src = p.source + "[gcc/" + driver + "]",
        after = "      string = " + lookup + ";\n      if (!string)\n\tfatal_error (input_location, \"declared compiler tool not found: %s\", commands[0].prog);\n      commands[0].argv[0] = string;",
        before = "      string = " + lookup + ";\n      if (string)\n\tcommands[0].argv[0] = string;",
        output = driver,
    )

    exact_patch(
        name = driver,
        src = ":driver-tool" + p.suffix,
        after = "\tif (!string)\n\t  fatal_error (input_location, \"declared compiler tool not found: %s\", commands[n_commands].prog);\n\tcommands[n_commands].argv[0] = string;",
        before = "\tif (string)\n\t  commands[n_commands].argv[0] = string;",
        output = driver,
    )

    # Static native executables only: no dynamic linker, PIE, shared objects
    # or 32-bit multilibs. There is no collect2, so the driver runs ld
    # directly.
    write_file(
        name = "driver-tm.h",
        content = '#include "../gcc/tm.h"\n#undef LINK_SPEC\n#define LINK_SPEC "-m elf_x86_64 -static %{m32|mx32:%eOnly native x86_64 is supported} %{shared|pie|static-pie:%eOnly static executables are supported}"\n#undef STARTFILE_SPEC\n#define STARTFILE_SPEC "crt1.o%s crti.o%s crtbeginT.o%s"\n#undef ENDFILE_SPEC\n#define ENDFILE_SPEC GNU_USER_TARGET_MATHFILE_SPEC " crtend.o%s crtn.o%s"\n#undef LIB_SPEC\n#define LIB_SPEC "-lc"\n#undef LINK_GCC_C_SEQUENCE_SPEC\n#define LINK_GCC_C_SEQUENCE_SPEC "--start-group %G %{!nolibc:%L} --end-group"\n#undef LINK_EH_SPEC\n#define LINK_EH_SPEC ""\n',
    )

    compiler_trees = _compiler_trees(p)
    [
        filegroup(
            name = stage + "-driver-tree",
            srcs = compiler_trees[stage] | {
                "gcc/" + driver: ":" + driver,
                "build/driver/tm.h": ":driver-tm.h",
            },
        )
        for stage in STAGES
    ]

    object_defines = _object_defines(p)
    includes = _compiler_includes(p)
    [
        c_object(
            name = stage + "-driver-" + name.replace("/", "-") + ".o",
            src = ":" + stage + "-driver-tree",
            defines = COMPILER_DEFINES + object_defines.get(name, []) + (["IN_GCC_FRONTEND=1"] if name in [
                "c/gccspec",
                "cp/g++spec",
            ] else []),
            flags = _compiler_flags(stage),
            logical_includes = ["build/driver"] + includes[:2] + (["gcc/" + name.rpartition("/")[0]] if "/" in name else []) + includes[2:],
            logical_source = _gcc_source(p, name),
            object_name = "driver" + str(i) + ".o",
            source_tree = ":" + stage + "-driver-tree",
            toolchain = p.host_cxx[stage],
        )
        for stage in STAGES
        for i, name in enumerate(DRIVER_OBJECTS)
    ]

    [
        _host_program(
            p,
            name = stage + "-" + program,
            language = "c++",
            libraries = [":" + stage + "-" + name + ".a" for name in DRIVER_LIBRARIES] + ([":" + stage + "-libz.a"] if program == "gcov" else []),
            objects = [":" + stage + "-driver-" + name.replace("/", "-") + ".o" for name in objects],
            output = program,
            stage = stage,
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

    filegroup(
        name = "compiler-headers",
        srcs = {name: p.source + "[gcc/ginclude/" + name + "]" for name in COMPILER_HEADERS} |
               {name: p.source + "[gcc/config/i386/" + name + "]" for name in p.sources.intrinsic_headers} | {
            "stdint.h": p.source + "[gcc/ginclude/stdint-wrap.h]",
            "mm_malloc.h": p.source + "[gcc/config/i386/pmm_malloc.h]",
            "gcov.h": p.source + "[libgcc/gcov.h]",
            "unwind.h": p.source + "[libgcc/unwind-generic.h]",
        },
    )

    [
        filegroup(
            name = stage + "-native-tools",
            srcs = {
                "cc1": ":" + stage + "-cc1",
                "cc1plus": ":" + stage + "-cc1plus",
                "as": p.binutils + ":as",
                "ld": p.binutils + ":ld",
            },
        )
        for stage in STAGES
    ]

    # The driver before its own runtime exists: musl's C library only. It
    # builds the target runtime, so it cannot depend on it.
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
                tool = ":" + stage + "-xgcc",
            ),
            gcc_compiler(
                name = stage + "-bootstrap-gcc",
                binutils = p.binutils,
                command = ":" + stage + "-bootstrap-driver",
                sysroot = MUSL + ":runtime",
            ),
        ]
        for stage in STAGES
    ]

# libgcc/config.in for this target. Each release may add its own values;
# the header lists them all in autoheader's sorted order.
LIBGCC_CONFIG = {
    "AS_HIDDEN_DIRECTIVE": ".hidden",
    "HAVE_AS_AVX": "1",
    "HAVE_AS_CFI_SECTIONS": "1",
    "HAVE_CC_TLS": "1",
    "HAVE_FTW_H": "1",
    "HAVE_GETIPINFO": "1",
    "HAVE_INIT_PRIORITY": "1",
    "HAVE_INTTYPES_H": "1",
    "HAVE_MEMORY_H": "1",
    "HAVE_STDINT_H": "1",
    "HAVE_STDLIB_H": "1",
    "HAVE_STRINGS_H": "1",
    "HAVE_STRING_H": "1",
    "HAVE_SYS_AUXV_H": "1",
    "HAVE_SYS_STAT_H": "1",
    "HAVE_SYS_TYPES_H": "1",
    "HAVE_UNISTD_H": "1",
    "PACKAGE_BUGREPORT": '""',
    "PACKAGE_NAME": '"GNU C Runtime Library"',
    "PACKAGE_STRING": '"GNU C Runtime Library 1.0"',
    "PACKAGE_TARNAME": '"libgcc"',
    "PACKAGE_URL": '"http://www.gnu.org/software/libgcc/"',
    "PACKAGE_VERSION": '"1.0"',
    "SIZEOF_DOUBLE": "8",
    "SIZEOF_LONG_DOUBLE": "16",
    "STDC_HEADERS": "1",
}

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

# Upstream's x86 startup files beside crtbeginT.o and crtend.o: the driver
# links crtfastmath.o for -ffast-math and a crtprec object for -mpc32 to
# -mpc80.
MATH_STARTUP_OBJECTS = [
    "crtprec32.o",
    "crtprec64.o",
    "crtprec80.o",
    "crtfastmath.o",
]

def _runtime(p):
    # GCC enables the x86_64 signal-frame unwinder only for glibc. musl's
    # __restore_rt is the same rt_sigreturn sequence, so enable it for musl
    # too.
    exact_patch(
        name = "linux-unwind.h",
        src = p.source + "[libgcc/config/i386/linux-unwind.h]",
        after = "#if !defined __GLIBC__ || !(__GLIBC__ == 2 && __GLIBC_MINOR__ == 0)",
        before = "#if defined __GLIBC__ && !(__GLIBC__ == 2 && __GLIBC_MINOR__ == 0)",
        output = "linux-unwind.h",
    )

    write_file(
        name = "auto-target.h",
        content = "\n".join(["#define " + name + " " + value for name, value in sorted((LIBGCC_CONFIG | p.config.libgcc_config).items())]) + "\n",
    )

    # libgcc/mkheader.sh output.
    write_file(
        name = "libgcc_tm.h",
        content = '#ifndef LIBGCC_TM_H\n#define LIBGCC_TM_H\n/* Automatically generated by mkheader.sh.  */\n#include "config/i386/elf-lib.h"\n#include "config/i386/value-unwind.h"\n#endif /* LIBGCC_TM_H */\n',
    )

    # The libgcc objdir: configuration headers and the links configure
    # creates.
    compiler_trees = _compiler_trees(p)
    [
        filegroup(
            name = stage + "-runtime-tree",
            srcs = compiler_trees[stage] | {
                "libgcc": p.source + "[libgcc]",
                "build/libgcc/auto-target.h": ":auto-target.h",
                "build/libgcc/libgcc_tm.h": ":libgcc_tm.h",
                "build/libgcc/md-unwind-support.h": ":linux-unwind.h",
                "build/libgcc/unwind.h": p.source + "[libgcc/unwind-generic.h]",
                "build/libgcc/sfp-machine.h": p.source + "[libgcc/config/i386/sfp-machine.h]",
                "build/libgcc/gthr-default.h": p.source + "[libgcc/gthr-posix.h]",
                "build/libgcc/enable-execute-stack.c": p.source + "[libgcc/enable-execute-stack-empty.c]",
            },
        )
        for stage in STAGES
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
            source_tree = ":" + stage + "-runtime-tree",
            toolchain = ":" + stage + "-bootstrap-gcc",
        )
        for stage in STAGES
        for i, (name, source, defines, flags) in enumerate(p.sources.libgcc_objects)
    ]

    [
        c_library(
            name = stage + "-libgcc.a",
            objects = [":" + stage + "-libgcc-" + name + ".o" for name, source, defines, flags in p.sources.libgcc_objects],
            output = "libgcc.a",
            toolchain = ":" + stage + "-bootstrap-gcc",
        )
        for stage in STAGES
    ]

    # What a program that this stage's compiler links gets around its own
    # objects.
    [
        link_runtime(
            name = stage + "-link-runtime",
            end_objects = [
                ":" + stage + "-crtend.o",
                MUSL + ":crtn.o",
            ],
            libraries = [
                MUSL + ":libc.a",
                ":" + stage + "-libgcc.a",
                MUSL + ":libc.a",
            ],
            start_objects = [
                MUSL + ":crt1.o",
                MUSL + ":crti.o",
                ":" + stage + "-crtbeginT.o",
            ],
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
            source_tree = ":" + stage + "-runtime-tree",
            toolchain = ":" + stage + "-bootstrap-gcc",
        )
        for stage in STAGES
        for i, (name, source, define) in enumerate(p.sources.libgcov_objects)
    ]

    [
        c_library(
            name = stage + "-libgcov.a",
            objects = [":" + stage + "-libgcov-" + name + ".o" for name, source, define in p.sources.libgcov_objects],
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
                      ] + MATH_STARTUP_OBJECTS},
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
                tool = ":" + stage + "-xgcc",
            ),
            gcc_compiler(
                name = stage + "-gcc",
                binutils = p.binutils,
                command = ":" + stage + "-gcc-command",
                sysroot = ":" + stage + "-runtime",
            ),
        ]
        for stage in STAGES
    ]

# Programs each stage's driver builds and runs at -O0 and -O2: (name,
# source, flags).
RUNTIME_TESTS = [
    ("integer-complex", GCC40 + ":tests/libgcc.c", []),
    (
        "unwind",
        GCC40 + ":tests/unwind.c",
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
        GCC40 + ":tests/c-language.c",
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
    # The driver adds upstream's x86 math startup files: crtfastmath.o for
    # -ffast-math and crtprec32.o for -mpc32.
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

def _acceptance_tests(p, runtime_tests):
    # Front ends, driver and runtime acceptance for the first stage.
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
            "$(location " + GCC40 + ":tests/c-language.c)",
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
        capture = True,
        tool = ":stage1-xgcc",
    )

    generate(
        name = "version-line.txt",
        args = [
            "1!d",
            "$(location :version-output.txt)",
        ],
        capture = True,
        tool = SED,
    )

    write_file(
        name = "version-expected.txt",
        content = "xgcc (Cellar bootstrap) " + p.version + "\n",
    )

    compare_test(
        name = "driver-version",
        actual = ":version-line.txt",
        expected = ":version-expected.txt",
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
        capture = True,
        tool = ":stage1-cpp",
    )

    compare_test(
        name = "driver-preprocessing",
        actual = ":cpp-output.txt",
        expected = ":cpp-expected.txt",
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
                chdir = True,
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
        for name, source, extra in RUNTIME_TESTS + runtime_tests
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
                chdir = True,
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

    # Each stage's gcov reports an instrumented program that its driver
    # compiled and ran.
    c_object(
        name = "coverage-runner.o",
        src = SHARED + ":tests/coverage-runner.c",
        flags = [
            "-O2",
            "-Werror",
        ],
        toolchain = p.host_cc["stage1"],
    )

    _host_program(
        p,
        name = "coverage-runner",
        objects = [":coverage-runner.o"],
        stage = "stage1",
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
                chdir = True,
                directory = True,
                env = {"TMPDIR": "."},
                files = ["passed"],
                tool = ":coverage-runner",
            ),
            result_test(
                name = stage + "-runtime-coverage",
                result = ":" + stage + "-coverage-result[passed]",
            ),
        ]
        for stage in STAGES
    ]

def _stage_comparison(p):
    # Upstream bootstrap compares the stage2 and stage3 objects. The two
    # checksum objects encode their own stage's link inputs and are the only
    # exclusions.
    compared = ["gen-" + name + ".o" for name in list(p.generator_programs) + ["bid"]] + [
        name + "-" + source.replace("/", "-") + ".o"
        for name, library in p.libraries.items()
        for source in library.objects
    ] + ["build-" + name + ".o" for name in p.generator_objects] + [
        "cc-" + name.replace("/", "-") + ".o"
        for name in p.compiler_object_names
    ] + ["zlib-" + name + ".o" for name in ZLIB_OBJECTS] + [
        "driver-" + name.replace("/", "-") + ".o"
        for name in DRIVER_OBJECTS
    ] + ["libgcc-" + name + ".o" for name, source, defines, flags in p.sources.libgcc_objects] + [
        "libgcov-" + name + ".o"
        for name, source, define in p.sources.libgcov_objects
    ] + [
        "crtbeginT.o",
        "crtend.o",
    ] + MATH_STARTUP_OBJECTS + [name + ".a" for name in list(p.libraries) + [
        "libbackend",
        "libcommon",
        "libcommon-target",
        "libz",
        "libgcc",
        "libgcov",
    ]] + list(p.compiler_objects)

    [
        compare_test(
            name = "compare-" + name,
            actual = ":stage2-" + name,
            expected = ":stage3-" + name,
        )
        for name in compared
    ]

    filegroup(
        name = "stage-comparison",
        srcs = {},
        tests = [":compare-" + name for name in compared],
    )

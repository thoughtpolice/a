# SPDX-FileCopyrightText: © 2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

load("@cellar//bootstrap:actions.bzl", "command_test", "compare_test", "concatenate", "generate", "result_test")
load("@cellar//bootstrap:defs.bzl", "filegroup")
load("@cellar//bootstrap:source.bzl", "exact_patch", "write_file")
load("@cellar//bootstrap/stage1:defs.bzl", "bootstrap_artifact", "c_binary", "c_library", "c_object", "link_runtime")

# This package's patches, tests and generators serve every release, except
# the ones a calling package names in `local_files`.
BINUTILS = "cellar//bootstrap/stage1/binutils"

BYTECMP = "cellar//bootstrap/stage0-posix/cellar-extra:bytecmp"

CATM = "cellar//bootstrap/stage0-posix/mescc-tools-extra:catm"

EXPECT_EXIT = "cellar//bootstrap/stage1/tools:expect-exit"

ZLIB = [
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

ZLIB_HEADERS = [
    "zlib/zconf.h",
    "zlib/zlib.h",
    "zlib/zutil.h",
    "zlib/deflate.h",
    "zlib/gzguts.h",
    "zlib/inffast.h",
    "zlib/inflate.h",
    "zlib/inftrees.h",
]

LICENSES = [
    "COPYING",
    "COPYING3",
    "COPYING.LIB",
    "COPYING3.LIB",
]

# These release-generated headers are projected only as comparison fixtures.
HEADER_FIXTURES = [
    "bfd/bfd-in2.h",
    "bfd/libbfd.h",
    "bfd/libcoff.h",
]

GPROF = [
    "basic_blocks",
    "call_graph",
    "cg_arcs",
    "cg_dfn",
    "cg_print",
    "corefile",
    "gmon_io",
    "gprof",
    "hertz",
    "hist",
    "source",
    "search_list",
    "symtab",
    "sym_ids",
    "utils",
    "i386",
]

GPROF_BLURBS = [
    "flat_bl",
    "bsd_callg_bl",
    "fsf_callg_bl",
]

GPROF_FILES = [
    "gprof/basic_blocks.c",
    "gprof/call_graph.c",
    "gprof/cg_arcs.c",
    "gprof/cg_dfn.c",
    "gprof/cg_print.c",
    "gprof/corefile.c",
    "gprof/gmon_io.c",
    "gprof/gprof.c",
    "gprof/hertz.c",
    "gprof/hist.c",
    "gprof/source.c",
    "gprof/search_list.c",
    "gprof/symtab.c",
    "gprof/sym_ids.c",
    "gprof/utils.c",
    "gprof/i386.c",
    "gprof/basic_blocks.h",
    "gprof/call_graph.h",
    "gprof/cg_arcs.h",
    "gprof/cg_dfn.h",
    "gprof/cg_print.h",
    "gprof/corefile.h",
    "gprof/gmon.h",
    "gprof/gmon_io.h",
    "gprof/gmon_out.h",
    "gprof/gprof.h",
    "gprof/hertz.h",
    "gprof/hist.h",
    "gprof/search_list.h",
    "gprof/source.h",
    "gprof/sym_ids.h",
    "gprof/symtab.h",
    "gprof/utils.h",
    "gprof/flat_bl.m",
    "gprof/bsd_callg_bl.m",
    "gprof/fsf_callg_bl.m",
    "gprof/gen-c-prog.awk",
]

LD_SCRIPTS = ["elf_x86_64." + suffix for suffix in [
    "xr",
    "xu",
    "x",
    "xe",
    "xn",
    "xbn",
    "xc",
    "xce",
    "xw",
    "xwe",
    "xs",
    "xse",
    "xsc",
    "xsce",
    "xsw",
    "xswe",
    "xd",
    "xde",
    "xdc",
    "xdce",
    "xdw",
    "xdwe",
]]

def _paths(sources):
    """Returns the release paths of each component's source tree."""
    return struct(
        libiberty = sources.common_headers + ["libiberty/" + name + ".c" for name in sources.libiberty] + LICENSES,
        libsframe = ["libsframe/" + name + ".c" for name in getattr(sources, "libsframe", [])] + getattr(sources, "libsframe_headers", []),
        zlib = ZLIB_HEADERS + ["zlib/" + name + ".c" for name in ZLIB],
        bfd = ["bfd/" + name + ".c" for name in sources.bfd] + sources.bfd_source_headers,
        opcode_fixtures = ["opcodes/" + name for name in sources.i386_tables],
        # flonum-konst.c is regenerated from integer arithmetic.
        gas = ["gas/" + name + ".c" for name in sources.gas if name != "flonum-konst"] + sources.gas_headers,
        # The parser, scanner and emulation are generated.
        ld = ["ld/" + name + ".c" for name in sources.ld if name not in [
            "ldgram",
            "eelf_x86_64",
        ]] + sources.ld_headers + sources.ld_generator_inputs + [
            "ld/ldgram.y",
            "ld/ldlex.l",
        ],
    )

def binutils_files(sources):
    """Lists every release path that `binutils_stage` reads."""
    paths = _paths(sources)
    return (
        ["zlib/" + name for name in getattr(sources, "zlib_fixtures", [])] +
        paths.libsframe +
        GPROF_FILES +
        sources.binutils_files +
        sources.binutils_headers +
        paths.ld +
        paths.gas +
        sources.opcodes_files +
        paths.opcode_fixtures +
        paths.libiberty +
        paths.zlib +
        sources.bfd_header_inputs +
        HEADER_FIXTURES +
        [path for path in paths.bfd if path not in sources.bfd_header_inputs]
    )

def _config_header(on, values, prologue = ""):
    return prologue + "\n".join(["#define " + name + " 1" for name in on]) + "\n" + "\n".join(["#define " + name + " " + value for name, value in values.items()]) + "\n"

def binutils_stage(
        sources,
        config,
        toolchain,
        libc_headers,
        crt,
        libc,
        crtn,
        cflags,
        tools,
        preprocessor = None,
        local_files = [],
        logical_sources = False,
        action_env = {}):
    """Declares the native binutils graph for one release and toolchain.

    `sources` and `config` are the release's SOURCES and CONFIG structs from
    its sources.bzl and config.bzl. The calling package must declare the
    `binutils-<version>` source target, whose subtargets are the release
    paths that `binutils_files(sources)` lists.

    `toolchain` compiles every object with `cflags` against `libc_headers`.
    Every program links `crt`, its own objects and libraries, `libc` and
    `crtn`, in that order. `tools` maps bash, bison, cat, flex, gawk, mkdir,
    rm and sed, and cmp where the release's linker emulation templates use
    it, to the generator executables. `preprocessor` is a C compiler command
    that accepts -E, for a release whose i386-gen reads a preprocessed
    opcode table. `action_env` adds environment variables to the actions
    that run Bash or Bison, and to those that give a test program a scratch
    TMPDIR.

    `local_files` names the patches, tests and generators that the calling
    package provides in place of this package's.

    Without `logical_sources`, component sources compile in place with their
    directories as `includes`. With it, each source tree is aliased to a
    stable logical path and its directories become `-Isource/...` flags.
    """

    version = sources.version

    # Features that only some releases have. A release's SOURCES or CONFIG
    # enables one by setting the field.
    libsframe = getattr(sources, "libsframe", [])
    zlib_fixtures = getattr(sources, "zlib_fixtures", [])
    zlib_crc32_main = getattr(sources, "zlib_crc32_main", False)
    preprocessed_opcode_table = getattr(sources, "preprocessed_opcode_table", False)
    gas_includes_opcode_tables = getattr(sources, "gas_includes_opcode_tables", False)
    ld_libpath_argument = getattr(sources, "ld_libpath_argument", False)
    ld_zlib_headers = getattr(sources, "ld_zlib_headers", False)
    bfd_stdint = getattr(config, "bfd_stdint", None)

    paths = _paths(sources)

    def release(path):
        return ":binutils-" + version + "[" + path + "]"

    def location(label):
        return "$(location " + label + ")"

    def package_file(path):
        return (":" if path in local_files else BINUTILS + ":") + path

    def source_attrs(tree, includes, logical_source, logical_includes = [], tree_flags = []):
        if not logical_sources:
            return {
                "flags": cflags,
                "includes": includes,
            }
        flags = []
        for include in includes:
            if include == tree:
                flags.append("-Isource/.")
            elif include.startswith(tree + "["):
                flags.append("-Isource/" + include[len(tree) + 1:-1])
            else:
                flags.append("-I" + location(include))
        return {
            "flags": flags + tree_flags + cflags,
            "logical_includes": logical_includes,
            "logical_source": logical_source,
            "source_tree": tree,
        }

    link_runtime(
        name = "link-runtime",
        end_objects = crtn,
        libraries = libc,
        start_objects = crt,
    )

    runtime = ":link-runtime"

    sframe_libraries = [":libsframe.a"] if libsframe else []

    # Every program that reads object files links these, in this order.
    bfd_libraries = [":libbfd.a"] + sframe_libraries + [
        ":libiberty.a",
        ":libz.a",
    ]

    write_file(
        name = "libiberty-config.h",
        content = _config_header(config.libiberty_on, config.libiberty_values, prologue = "#ifndef _GNU_SOURCE\n#define _GNU_SOURCE 1\n#endif\n"),
    )

    exact_patch(
        name = "make-temp-file.c",
        src = release("libiberty/make-temp-file.c"),
        patch = package_file("patches/tmpdir.patch"),
    )

    # The upstream commented C generator is the source of the CRC table. Its
    # published table is removed before the library consumes the prepared source.
    [
        generate(
            name = name,
            args = flags + [
                script,
                location(release("libiberty/crc32.c")),
            ],
            capture = True,
            tool = tools["sed"],
        )
        for name, flags, script in [
            (
                "crcgen.c",
                ["-n"],
                "/^   #include <stdio.h>/,/^   \\}$/p",
            ),
            ("crc32-prefix", [], "/crc_v3\\.txt/{n; q}"),
            ("crc32-suffix", [], "1,/^};$/d"),
        ]
    ]

    c_object(
        name = "crcgen.o",
        src = ":crcgen.c",
        flags = cflags,
        headers = [libc_headers],
        object_name = "crcgen.o",
        toolchain = toolchain,
    )

    c_binary(
        name = "crcgen",
        objects = [":crcgen.o"],
        output = "crcgen",
        runtime = runtime,
        toolchain = toolchain,
    )

    generate(
        name = "crc32-table",
        capture = True,
        tool = ":crcgen",
    )

    concatenate(
        name = "crc32.c",
        inputs = [
            ":crc32-prefix",
            ":crc32-table",
            ":crc32-suffix",
        ],
        tool = CATM,
    )

    filegroup(
        name = "libiberty-source",
        srcs = {path: release(path) for path in paths.libiberty} | {
            "libiberty/config.h": ":libiberty-config.h",
            "libiberty/crc32.c": ":crc32.c",
            "libiberty/make-temp-file.c": ":make-temp-file.c",
        },
    )

    [
        c_object(
            name = "iberty-" + name + ".o",
            src = ":libiberty-source[libiberty/" + name + ".c]",
            defines = ["HAVE_CONFIG_H=1"],
            headers = [
                ":libiberty-source",
                libc_headers,
            ],
            object_name = "ib{}.o".format(i),
            toolchain = toolchain,
            **source_attrs(
                tree = ":libiberty-source",
                # do not sort
                includes = [
                    ":libiberty-source[libiberty]",
                    ":libiberty-source[include]",
                ],
                logical_source = "libiberty/" + name + ".c",
            )
        )
        for i, name in enumerate(sources.libiberty)
    ]

    c_library(
        name = "libiberty.a",
        objects = [":iberty-" + name + ".o" for name in sources.libiberty],
        output = "libiberty.a",
        toolchain = toolchain,
    )

    c_object(
        name = "libiberty-test.o",
        src = package_file("tests/libiberty.c"),
        flags = cflags,
        headers = [
            ":libiberty-source",
            libc_headers,
        ],
        # do not sort
        includes = [
            ":libiberty-source[libiberty]",
            ":libiberty-source[include]",
        ],
        object_name = "test.o",
        toolchain = toolchain,
    )

    c_binary(
        name = "libiberty-test-bin",
        libraries = [":libiberty.a"],
        objects = [":libiberty-test.o"],
        output = "libiberty-test",
        runtime = runtime,
        toolchain = toolchain,
    )

    command_test(
        name = "libiberty-test",
        tool = ":libiberty-test-bin",
    )

    command_test(
        name = "libiberty-missing-tmpdir",
        args = [
            "1",
            "$(exe :libiberty-test-bin)",
            "temp",
        ],
        env = {"TMPDIR": ""},
        tool = EXPECT_EXIT,
    )

    generate(
        name = "libiberty-temp-output",
        args = ["temp"],
        chdir = True,
        directory = True,
        env = {"TMPDIR": "."} | action_env,
        files = ["passed"],
        tool = ":libiberty-test-bin",
    )

    result_test(
        name = "libiberty-temp",
        result = ":libiberty-temp-output[passed]",
    )

    # zlib's table writers regenerate crc32.h, trees.h and inffixed.h from a
    # library built in its table-generating modes. With `zlib_crc32_main`,
    # crc32.c has its own main that writes crc32.h, and the library computes
    # the CRC table at run time. The tests compare the regenerated tables
    # with the release's copies that `zlib_fixtures` names.
    filegroup(
        name = "zlib-bootstrap-source",
        srcs = {path: release(path) for path in paths.zlib},
    )

    [
        [
            c_object(
                name = stage + "-" + name + ".o",
                src = ":" + source + "[zlib/" + name + ".c]",
                defines = [
                    "_GNU_SOURCE=1",
                    "HAVE_UNISTD_H=1",
                ] + extra,
                flags = cflags,
                headers = [
                    ":" + source,
                    libc_headers,
                ],
                includes = [":" + source + "[zlib]"],
                object_name = "z{}.o".format(i),
                toolchain = toolchain,
            )
            for i, name in enumerate(ZLIB)
        ] + [
            c_library(
                name = stage + ".a",
                objects = [":" + stage + "-" + name + ".o" for name in ZLIB],
                output = "libz.a",
                toolchain = toolchain,
            ),
        ]
        for stage, source, extra in [
            (
                "zlib-bootstrap",
                "zlib-bootstrap-source",
                [
                    "GEN_TREES_H=1",
                    "DYNAMIC_CRC_TABLE=1" if zlib_crc32_main else "MAKECRCH=1",
                    "MAKEFIXED=1",
                    "BUILDFIXED=1",
                ],
            ),
            ("libz", "zlib-source", []),
        ]
    ]

    c_object(
        name = "zlib-tables.o",
        src = package_file("generators/zlib-tables.c"),
        flags = (["-Isource/include"] if logical_sources else []) + cflags,
        headers = [
            ":zlib-bootstrap-source",
            libc_headers,
        ],
        includes = [":zlib-bootstrap-source[zlib]"],
        object_name = "ztables.o",
        toolchain = toolchain,
    )

    c_binary(
        name = "zlib-tables",
        libraries = [":zlib-bootstrap.a"],
        objects = [":zlib-tables.o"],
        output = "zlib-tables",
        runtime = runtime,
        toolchain = toolchain,
    )

    [
        generate(
            name = "zlib-" + name,
            args = [name],
            chdir = True,
            directory = True,
            files = [name],
            tool = ":zlib-tables",
        )
        for name in ([] if zlib_crc32_main else ["crc32.h"]) + [
            "trees.h",
            "inffixed.h",
        ]
    ]

    if zlib_crc32_main:
        c_object(
            name = "zlib-crc32-gen.o",
            src = ":zlib-bootstrap-source[zlib/crc32.c]",
            defines = [
                "_GNU_SOURCE=1",
                "HAVE_UNISTD_H=1",
                "MAKECRCH=1",
            ],
            flags = cflags,
            headers = [
                ":zlib-bootstrap-source",
                libc_headers,
            ],
            includes = [":zlib-bootstrap-source[zlib]"],
            object_name = "crc32gen.o",
            toolchain = toolchain,
        )

        c_binary(
            name = "zlib-crc32-gen",
            objects = [":zlib-crc32-gen.o"],
            output = "zlib-crc32-gen",
            runtime = runtime,
            toolchain = toolchain,
        )

        generate(
            name = "zlib-crc32.h",
            chdir = True,
            directory = True,
            files = ["crc32.h"],
            tool = ":zlib-crc32-gen",
        )

    [
        compare_test(
            name = "zlib-" + name + "-regeneration",
            actual = ":zlib-" + name + "[" + name + "]",
            expected = release("zlib/" + name),
        )
        for name in zlib_fixtures
    ]

    filegroup(
        name = "zlib-source",
        srcs = {path: release(path) for path in paths.zlib} | {"zlib/" + name: ":zlib-" + name + "[" + name + "]" for name in [
            "crc32.h",
            "trees.h",
            "inffixed.h",
        ]},
    )

    c_object(
        name = "zlib-test.o",
        src = package_file("tests/zlib.c"),
        flags = cflags,
        headers = [
            ":zlib-source",
            libc_headers,
        ],
        includes = [":zlib-source[zlib]"],
        object_name = "ztest.o",
        toolchain = toolchain,
    )

    c_binary(
        name = "zlib-test-bin",
        libraries = [":libz.a"],
        objects = [":zlib-test.o"],
        output = "zlib-test",
        runtime = runtime,
        toolchain = toolchain,
    )

    command_test(
        name = "zlib-memory",
        tool = ":zlib-test-bin",
    )

    generate(
        name = "zlib-file-output",
        args = ["file"],
        chdir = True,
        directory = True,
        files = ["passed"],
        tool = ":zlib-test-bin",
    )

    result_test(
        name = "zlib-file",
        result = ":zlib-file-output[passed]",
    )

    filegroup(
        name = "bfd-header-source",
        srcs = {path: release(path) for path in sources.bfd_header_inputs + sources.common_headers},
    )

    c_object(
        name = "chew.o",
        src = ":bfd-header-source[bfd/doc/chew.c]",
        headers = [
            ":bfd-header-source",
            libc_headers,
        ],
        object_name = "chew.o",
        toolchain = toolchain,
        **source_attrs(
            tree = ":bfd-header-source",
            includes = [":bfd-header-source[include]"],
            logical_source = "bfd/doc/chew.c",
        )
    )

    c_binary(
        name = "chew",
        objects = [":chew.o"],
        output = "chew",
        runtime = runtime,
        toolchain = toolchain,
    )

    [
        [
            write_file(
                name = group + "-header-inputs",
                content = " ".join(inputs + ["doc/header.sed"]) + "\n",
            ),
            generate(
                name = group + "-header-comment",
                args = [
                    "-f",
                    location(":bfd-header-source[bfd/doc/header.sed]"),
                    location(":" + group + "-header-inputs"),
                ],
                capture = True,
                tool = tools["sed"],
            ),
            write_file(
                name = group + "-header-end",
                content = "#ifdef __cplusplus\n}\n#endif\n" + ("#endif\n" if guarded else ""),
            ),
        ] + [
            [
                write_file(
                    name = group + "-" + path + "-comment",
                    content = "/* Extracted from " + path + ".  */\n",
                ),
                generate(
                    name = group + "-" + path + "-decls",
                    args = (["-i"] if internal else []) + [
                        "-f",
                        location(":bfd-header-source[bfd/doc/proto.str]"),
                    ],
                    capture = True,
                    stdin = ":bfd-header-source[bfd/" + path + "]",
                    tool = ":chew",
                ),
            ]
            for path in inputs[1:]
        ] + [
            concatenate(
                name = group + "-header-raw",
                inputs = [
                    ":" + group + "-header-comment",
                    ":bfd-header-source[bfd/" + inputs[0] + "]",
                ] + [":" + group + "-" + path + suffix for path in inputs[1:] for suffix in [
                    "-comment",
                    "-decls",
                ]] + [":" + group + "-header-end"],
                tool = CATM,
            ),
            compare_test(
                name = group + "-header-regeneration",
                actual = ":" + group + "-header-raw",
                expected = release("bfd/" + ("bfd-in2" if group == "bfd" else group) + ".h"),
            ),
        ]
        for group, inputs, internal, guarded in sources.bfd_header_groups
    ]

    generate(
        name = "bfd.h",
        args = [arg for name, value in config.bfd_native.items() for arg in [
            "-e",
            "s|@" + name + "@|" + value + "|g",
        ]] + [location(":bfd-header-raw")],
        capture = True,
        tool = tools["sed"],
    )

    generate(
        name = "elf64-target.h",
        args = [
            "s/NN/64/g",
            location(":bfd-header-source[bfd/elfxx-target.h]"),
        ],
        capture = True,
        tool = tools["sed"],
    )

    generate(
        name = "targmatch.h",
        args = [
            "-f",
            location(":bfd-header-source[bfd/targmatch.sed]"),
            location(":bfd-header-source[bfd/config.bfd]"),
        ],
        capture = True,
        tool = tools["sed"],
    )

    # bfd/configure writes the version as the major number followed by the
    # minor number and three more two-digit fields.
    major, minor = version.split(".")

    BFD_VERSION = {
        "bfd_version": major + minor + "000000",
        "bfd_version_string": '"' + version + '"',
        "bfd_version_package": '""',
        "report_bugs_to": '"https://www.sourceware.org/bugzilla/"',
    }

    generate(
        name = "bfdver.h",
        args = [arg for name, value in BFD_VERSION.items() for arg in [
            "-e",
            "s|@" + name + "@|" + value + "|g",
        ]] + [location(":bfd-header-source[bfd/version.h]")],
        capture = True,
        tool = tools["sed"],
    )

    if bfd_stdint:
        write_file(
            name = "bfd_stdint.h",
            content = bfd_stdint,
        )

    BFD_GENERATED = [
        "bfd.h",
        "bfdver.h",
    ] + (["bfd_stdint.h"] if bfd_stdint else []) + [
        "elf64-target.h",
        "targmatch.h",
    ]

    filegroup(
        name = "bfd-headers",
        srcs = {path: ":bfd-header-source[" + path + "]" for path in sources.common_headers} | {"bfd/" + name: ":" + name for name in BFD_GENERATED} | {
            "bfd/libbfd.h": ":libbfd-header-raw",
            "bfd/libcoff.h": ":libcoff-header-raw",
        },
    )

    c_object(
        name = "bfd-header-test.o",
        src = package_file("tests/bfd-headers.c"),
        defines = ['PACKAGE_VERSION="' + version + '"'],
        flags = cflags,
        headers = [
            ":bfd-headers",
            libc_headers,
        ],
        includes = [
            ":bfd-headers[bfd]",
            ":bfd-headers[include]",
        ],
        object_name = "headers.o",
        toolchain = toolchain,
    )

    c_binary(
        name = "bfd-header-test-bin",
        objects = [":bfd-header-test.o"],
        output = "bfd-headers-test",
        runtime = runtime,
        toolchain = toolchain,
    )

    command_test(
        name = "bfd-native-headers",
        tool = ":bfd-header-test-bin",
    )

    write_file(
        name = "bfd-config.h",
        content = _config_header(config.bfd_on, config.bfd_values),
    )

    # The first vector is native ELF64. Subsequent vectors in this translation
    # unit implement other OS ABIs and x32, which are outside the native port.
    generate(
        name = "elf64-x86-64.c",
        args = [
            '/^[#]include "elf64-target.h"/q',
            location(release("bfd/elf64-x86-64.c")),
        ],
        capture = True,
        tool = tools["sed"],
    )

    filegroup(
        name = "bfd-source",
        srcs = {path: release(path) for path in paths.bfd + sources.common_headers} | {"bfd/" + name: ":bfd-headers[bfd/" + name + "]" for name in BFD_GENERATED + [
            "libbfd.h",
            "libcoff.h",
        ]} | {
            "bfd/config.h": ":bfd-config.h",
            "bfd/elf64-x86-64.c": ":elf64-x86-64.c",
        },
    )

    [
        c_object(
            name = "bfd-" + name + ".o",
            src = ":bfd-source[bfd/" + name + ".c]",
            headers = [
                ":bfd-source",
                ":zlib-source",
                libc_headers,
            ],
            object_name = "bfd{}.o".format(i),
            toolchain = toolchain,
            **source_attrs(
                tree = ":bfd-source",
                # do not sort
                includes = [
                    ":bfd-source[bfd]",
                    ":bfd-source[include]",
                    ":zlib-source[zlib]",
                ],
                logical_source = "bfd/" + name + ".c",
            )
        )
        for i, name in enumerate(sources.bfd)
    ]

    c_library(
        name = "libbfd.a",
        objects = [":bfd-" + name + ".o" for name in sources.bfd],
        output = "libbfd.a",
        toolchain = toolchain,
    )

    if libsframe:
        write_file(
            name = "libsframe-config.h",
            content = _config_header(config.libsframe_on, config.libsframe_values),
        )

        filegroup(
            name = "libsframe-source",
            srcs = {path: release(path) for path in paths.libsframe + sources.common_headers} | {
                "libsframe/config.h": ":libsframe-config.h",
            },
        )

        [
            c_object(
                name = "sframe-" + name + ".o",
                src = ":libsframe-source[libsframe/" + name + ".c]",
                defines = ["HAVE_CONFIG_H=1"],
                headers = [
                    ":libsframe-source",
                    libc_headers,
                ],
                object_name = "sframe{}.o".format(i),
                toolchain = toolchain,
                **source_attrs(
                    tree = ":libsframe-source",
                    # do not sort
                    includes = [
                        ":libsframe-source[libsframe]",
                        ":libsframe-source[include]",
                        ":libsframe-source[libctf]",
                    ],
                    logical_source = "libsframe/" + name + ".c",
                )
            )
            for i, name in enumerate(libsframe)
        ]

        c_library(
            name = "libsframe.a",
            objects = [":sframe-" + name + ".o" for name in libsframe],
            output = "libsframe.a",
            toolchain = toolchain,
        )

    c_object(
        name = "bfd-test.o",
        src = package_file("tests/bfd.c"),
        flags = cflags,
        headers = [
            ":bfd-source",
            libc_headers,
        ],
        # do not sort
        includes = [
            ":bfd-source[bfd]",
            ":bfd-source[include]",
        ],
        object_name = "bfdtest.o",
        toolchain = toolchain,
    )

    c_binary(
        name = "bfd-test-bin",
        libraries = bfd_libraries,
        objects = [":bfd-test.o"],
        output = "bfd-test",
        runtime = runtime,
        toolchain = toolchain,
    )

    command_test(
        name = "bfd-read-object-archive",
        args = [
            location(":iberty-argv.o"),
            location(":libiberty.a"),
        ],
        tool = ":bfd-test-bin",
    )

    generate(
        name = "bfd-write-output",
        chdir = True,
        directory = True,
        env = {"TMPDIR": "."} | action_env,
        files = ["passed"],
        tool = ":bfd-test-bin",
    )

    result_test(
        name = "bfd-write-object",
        result = ":bfd-write-output[passed]",
    )

    write_file(
        name = "opcodes-config.h",
        content = _config_header(config.opcodes_on, config.opcodes_values),
    )

    # The source changes keep i386-gen's --srcdir an input directory. The
    # generated tables go to the action's separate output directory instead
    # of mutating the source tree.
    [
        exact_patch(
            name = name,
            src = (release("opcodes/i386-gen.c") if i == 0 else ":" + sources.i386_gen_patches[i - 1]),
            patch = package_file("patches/" + name + ".patch"),
        )
        for i, name in enumerate(sources.i386_gen_patches)
    ]

    filegroup(
        name = "opcodes-bootstrap-source",
        srcs = {path: release(path) for path in sources.opcodes_files + sources.common_headers + ["include/opcode/i386.h"]} | {
            "opcodes/config.h": ":opcodes-config.h",
            "opcodes/i386-gen.c": ":" + sources.i386_gen_patches[-1],
        },
    )

    c_object(
        name = "i386-gen.o",
        src = ":opcodes-bootstrap-source[opcodes/i386-gen.c]",
        headers = [
            ":opcodes-bootstrap-source",
            libc_headers,
        ],
        object_name = "i386gen.o",
        toolchain = toolchain,
        **source_attrs(
            tree = ":opcodes-bootstrap-source",
            # do not sort
            includes = [
                ":opcodes-bootstrap-source[opcodes]",
                ":opcodes-bootstrap-source[include]",
            ],
            logical_source = "opcodes/i386-gen.c",
            # do not sort
            logical_includes = [
                "opcodes",
                "include",
            ],
        )
    )

    c_binary(
        name = "i386-gen",
        libraries = [":libiberty.a"],
        objects = [":i386-gen.o"],
        output = "i386-gen",
        runtime = runtime,
        toolchain = toolchain,
    )

    i386_gen_input = ":opcodes-bootstrap-source[opcodes]"

    # With `preprocessed_opcode_table`, i386-gen reads the C-preprocessed
    # opcode table. It ignores line markers, so the preprocessor's paths do
    # not reach the generated tables.
    if preprocessed_opcode_table:
        generate(
            name = "i386-opc.i",
            args = [
                "-E",
                "-x",
                "c",
                "-DHAVE_CONFIG_H",
                "-I" + location(":opcodes-bootstrap-source[opcodes]"),
                "-I" + location(":opcodes-bootstrap-source[include]"),
                location(":opcodes-bootstrap-source[opcodes/i386-opc.tbl]"),
            ],
            capture = True,
            inputs = [":opcodes-bootstrap-source"],
            output = "i386-opc.i",
            tool = preprocessor,
        )

        filegroup(
            name = "i386-gen-input",
            srcs = {
                "i386-opc.i": ":i386-opc.i",
                "i386-reg.tbl": release("opcodes/i386-reg.tbl"),
            },
        )

        i386_gen_input = ":i386-gen-input"

    generate(
        name = "i386-tables",
        args = [
            "--srcdir",
            location(i386_gen_input),
        ],
        chdir = True,
        directory = True,
        files = sources.i386_tables,
        tool = ":i386-gen",
    )

    [
        compare_test(
            name = name + "-regeneration",
            actual = ":i386-tables[" + name + "]",
            expected = release("opcodes/" + name),
        )
        for name in sources.i386_tables
    ]

    filegroup(
        name = "opcodes-source",
        srcs = {path: ":opcodes-bootstrap-source[" + path + "]" for path in sources.opcodes_files + sources.common_headers + ["include/opcode/i386.h"]} | {"opcodes/config.h": ":opcodes-config.h"} | {"opcodes/" + name: ":i386-tables[" + name + "]" for name in sources.i386_tables},
    )

    [
        c_object(
            name = "opcode-" + name + ".o",
            src = ":opcodes-source[opcodes/" + name + ".c]",
            headers = [
                ":opcodes-source",
                ":bfd-headers",
                libc_headers,
            ],
            object_name = "opc{}.o".format(i),
            toolchain = toolchain,
            **source_attrs(
                tree = ":opcodes-source",
                # do not sort
                includes = [
                    ":opcodes-source[opcodes]",
                    ":opcodes-source[include]",
                    ":bfd-headers[bfd]",
                ],
                logical_source = "opcodes/" + name + ".c",
                # do not sort
                logical_includes = [
                    "opcodes",
                    "include",
                ],
            )
        )
        for i, name in enumerate(sources.opcodes)
    ]

    c_library(
        name = "libopcodes.a",
        objects = [":opcode-" + name + ".o" for name in sources.opcodes],
        output = "libopcodes.a",
        toolchain = toolchain,
    )

    c_object(
        name = "opcodes-test.o",
        src = package_file("tests/opcodes.c"),
        flags = cflags,
        headers = [
            ":opcodes-source",
            ":bfd-headers",
            libc_headers,
        ],
        # do not sort
        includes = [
            ":opcodes-source[opcodes]",
            ":opcodes-source[include]",
            ":bfd-headers[bfd]",
        ],
        object_name = "opctest.o",
        toolchain = toolchain,
    )

    c_binary(
        name = "opcodes-test-bin",
        libraries = [":libopcodes.a"] + bfd_libraries,
        objects = [":opcodes-test.o"],
        output = "opcodes-test",
        runtime = runtime,
        toolchain = toolchain,
    )

    command_test(
        name = "opcodes-disassembly",
        tool = ":opcodes-test-bin",
    )

    write_file(
        name = "gas-config.h",
        content = _config_header(config.gas_on, config.gas_values),
    )

    # The original flonum constants describe a missing historical bc script. Build
    # all 26 powers directly with bounded base-65536 integer arithmetic instead.
    c_object(
        name = "flonum-gen.o",
        src = package_file("generators/flonum.c"),
        flags = cflags,
        headers = [libc_headers],
        object_name = "flonum.o",
        toolchain = toolchain,
    )

    c_binary(
        name = "flonum-gen",
        objects = [":flonum-gen.o"],
        output = "flonum-gen",
        runtime = runtime,
        toolchain = toolchain,
    )

    generate(
        name = "flonum-konst.c",
        capture = True,
        tool = ":flonum-gen",
    )

    filegroup(
        name = "gas-source",
        srcs = {path: release(path) for path in paths.gas} | {
            "gas/config.h": ":gas-config.h",
            "gas/targ-cpu.h": release("gas/config/tc-i386.h"),
            "gas/obj-format.h": release("gas/config/obj-elf.h"),
            "gas/targ-env.h": release("gas/config/te-linux.h"),
            "gas/flonum-konst.c": ":flonum-konst.c",
        },
    )

    [
        c_object(
            name = "gas-" + name.replace("/", "-") + ".o",
            src = ":gas-source[gas/" + name + ".c]",
            headers = [
                ":gas-source",
                ":bfd-source",
                ":opcodes-source",
                ":zlib-source",
                libc_headers,
            ],
            object_name = "gas{}.o".format(i),
            toolchain = toolchain,
            **source_attrs(
                tree = ":gas-source",
                # do not sort
                includes = [
                    ":gas-source[gas]",
                    ":gas-source[gas/config]",
                    ":bfd-source[bfd]",
                    ":bfd-source[include]",
                    ":bfd-source",
                    ":opcodes-source",
                    ":zlib-source[zlib]",
                ],
                logical_source = "gas/" + name + ".c",
                # do not sort
                logical_includes = [
                    "gas",
                    "gas/config",
                ],
            )
        )
        for i, name in enumerate(sources.gas)
    ]

    # With `gas_includes_opcode_tables`, tc-i386 compiles in the x86 tables
    # and the assembler links no libopcodes.
    c_binary(
        name = "as",
        libraries = ([] if gas_includes_opcode_tables else [":libopcodes.a"]) + bfd_libraries,
        objects = [":gas-" + name.replace("/", "-") + ".o" for name in sources.gas],
        output = "as",
        runtime = runtime,
        toolchain = toolchain,
    )

    command_test(
        name = "as-version",
        args = ["--version"],
        tool = ":as",
    )

    generate(
        name = "as-fixture",
        args = [
            "--64",
            location(package_file("tests/native.s")),
            "-o",
        ],
        output = "native.o",
        tool = ":as",
    )

    bootstrap_artifact(
        name = "as-fixture.o",
        src = ":as-fixture",
        abi = "x86_64-sysv",
        archive_format = "ar",
        kind = "object",
        object_format = "elf64-x86-64",
    )

    c_object(
        name = "as-test.o",
        src = package_file("tests/assembler.c"),
        flags = cflags,
        headers = [libc_headers],
        object_name = "astest.o",
        toolchain = toolchain,
    )

    c_binary(
        name = "as-test-bin",
        objects = [
            ":as-test.o",
            ":as-fixture.o",
        ],
        output = "as-test",
        runtime = runtime,
        toolchain = toolchain,
    )

    command_test(
        name = "as-native-code-data",
        tool = ":as-test-bin",
    )

    command_test(
        name = "as-object-format",
        args = [
            location(":as-fixture"),
            location(":libiberty.a"),
        ],
        tool = ":bfd-test-bin",
    )

    command_test(
        name = "as-diagnostics",
        args = [
            "1",
            "$(exe :as)",
            "--64",
            location(package_file("tests/invalid.s")),
            "-o",
            "/dev/null",
        ],
        tool = EXPECT_EXIT,
    )

    # Native ELF linker. Grammar, scanner, emulation and scripts are regenerated
    # independently; none of the release-generated C parsers is an input.
    emulation_template = "emultempl/" + sources.ld_emulation_template

    [
        exact_patch(
            name = name,
            src = release(path),
            patch = package_file("patches/" + name + ".patch"),
        )
        for name, path in [
            ("ld-stringify", "ld/" + emulation_template),
            ("ld-template-lines", "ld/genscrba.sh"),
        ]
    ]

    filegroup(
        name = "ld-generator-source",
        srcs = {path[3:]: release(path) for path in sources.ld_generator_inputs} | {
            emulation_template: ":ld-stringify",
            "genscrba.sh": ":ld-template-lines",
        },
    )

    filegroup(
        name = "ld-generator-tools",
        srcs = {name: tools[name] for name in [
            "cat",
            "cmp",
            "mkdir",
            "rm",
            "sed",
        ] if name in tools},
    )

    # The linker gets no dependency directory and no default library search
    # path, which genscripts.sh spells ":". genscripts.sh reads the search
    # path from LIB_PATH, or with `ld_libpath_argument` from the argument
    # after the dependency directory.
    generate(
        name = "ld-emulation",
        args = [
            location(":ld-generator-source[genscripts.sh]"),
            location(":ld-generator-source"),
            "/nonexistent-bootstrap-binutils/lib",
            "/nonexistent-bootstrap-binutils",
            "/nonexistent-bootstrap-binutils",
            "x86_64-unknown-linux-musl",
            "x86_64-unknown-linux-musl",
            "x86_64-linux-musl",
        ] + ([
            "",
            ":",
        ] if ld_libpath_argument else []) + [
            "elf_x86_64",
            "",
            "yes",
            "yes",
            "elf_x86_64",
        ],
        chdir = True,
        directory = True,
        env = ({} if ld_libpath_argument else {"LIB_PATH": ":"}) | {
            "PATH": location(":ld-generator-tools"),
            "TMPDIR": ".",
        } | action_env,
        files = ["eelf_x86_64.c"] + ["ldscripts/" + name for name in LD_SCRIPTS],
        inputs = [":ld-generator-source"],
        tool = tools["bash"],
    )

    generate(
        name = "ld-parser",
        args = [
            "--no-lines",
            "-d",
            "-o",
            "ldgram.c",
            location(release("ld/ldgram.y")),
        ],
        chdir = True,
        directory = True,
        env = {"TMPDIR": "."} | action_env,
        files = [
            "ldgram.c",
            "ldgram.h",
        ],
        tool = tools["bison"],
    )

    generate(
        name = "ld-scanner",
        args = [
            "-L",
            "-t",
            location(release("ld/ldlex.l")),
        ],
        capture = True,
        tool = tools["flex"],
    )

    write_file(
        name = "ld-config.h",
        content = _config_header(config.ld_on, config.ld_values),
    )

    write_file(
        name = "ldemul-list.h",
        content = "extern ld_emulation_xfer_type ld_elf_x86_64_emulation;\n#define EMULATION_LIST &ld_elf_x86_64_emulation, 0\n",
    )

    filegroup(
        name = "ld-source",
        srcs = {path[3:]: release(path) for path in paths.ld if path not in sources.ld_generator_inputs} | {
            "config.h": ":ld-config.h",
            "ldgram.c": ":ld-parser[ldgram.c]",
            "ldgram.h": ":ld-parser[ldgram.h]",
            "ldlex.c": ":ld-scanner",
            "ldemul-list.h": ":ldemul-list.h",
            "eelf_x86_64.c": ":ld-emulation[eelf_x86_64.c]",
        },
    )

    # With `ld_zlib_headers`, the linker's sources include zlib.h.
    [
        c_object(
            name = "ld-" + name + ".o",
            src = ":ld-source[" + name + ".c]",
            headers = [
                ":ld-source",
                ":bfd-source",
            ] + ([":zlib-source"] if ld_zlib_headers else []) + [libc_headers],
            object_name = "ld{}.o".format(i),
            toolchain = toolchain,
            **source_attrs(
                tree = ":ld-source",
                # do not sort
                includes = [
                    ":ld-source",
                    ":bfd-source[bfd]",
                    ":bfd-source[include]",
                ] + ([":zlib-source[zlib]"] if ld_zlib_headers else []),
                logical_source = name + ".c",
                # do not sort
                logical_includes = ["."],
            )
        )
        for i, name in enumerate(sources.ld)
    ]

    c_binary(
        name = "ld",
        libraries = bfd_libraries,
        objects = [":ld-" + name + ".o" for name in sources.ld],
        output = "ld",
        runtime = runtime,
        toolchain = toolchain,
    )

    command_test(
        name = "ld-version",
        args = ["--version"],
        tool = ":ld",
    )

    c_library(
        name = "ld-fixture.a",
        objects = [":as-fixture.o"],
        output = "native.a",
        toolchain = toolchain,
    )

    # GNU ld owns these link actions; the predecessor compiler supplies the
    # input objects.
    generate(
        name = "ld-partial",
        args = [
            "-r",
            location(":as-test.o"),
            location(":as-fixture.o"),
            "-o",
        ],
        output = "partial.o",
        tool = ":ld",
    )

    [
        generate(
            name = "ld-" + name,
            args = [
                "-static",
                "--build-id=sha1",
            ] + [location(obj) for obj in crt + objects + libc + crtn] + ["-o"],
            output = name,
            tool = ":ld",
        )
        for name, objects in [
            (
                "direct",
                [
                    ":as-test.o",
                    ":as-fixture.o",
                ],
            ),
            (
                "archive",
                [
                    ":as-test.o",
                    ":ld-fixture.a",
                ],
            ),
            (
                "partial-final",
                [":ld-partial"],
            ),
        ]
    ]

    [
        command_test(
            name = "ld-" + name + "-execution",
            args = [
                "0",
                location(":ld-" + name),
            ],
            tool = EXPECT_EXIT,
        )
        for name in [
            "direct",
            "archive",
            "partial-final",
        ]
    ]

    generate(
        name = "ld-script-object",
        args = [
            "--64",
            location(package_file("tests/linker.s")),
            "-o",
        ],
        output = "script.o",
        tool = ":as",
    )

    generate(
        name = "ld-script-program",
        args = [
            "-static",
            "--gc-sections",
            "-T",
            location(package_file("tests/linker.ld")),
            location(":ld-script-object"),
            "-o",
        ],
        output = "script-test",
        tool = ":ld",
    )

    command_test(
        name = "ld-script-execution",
        args = [
            "0",
            location(":ld-script-program"),
        ],
        tool = EXPECT_EXIT,
    )

    [
        command_test(
            name = "ld-" + name,
            args = [
                "1",
                "$(exe :ld)",
            ] + args + [
                "-o",
                "/dev/null",
            ],
            tool = EXPECT_EXIT,
        )
        for name, args in [
            (
                "missing-library",
                [
                    "-static",
                    location(":as-test.o"),
                    "-lc",
                ],
            ),
            (
                "unresolved-symbol",
                [
                    "-static",
                    location(":as-fixture.o"),
                ],
            ),
            (
                "invalid-script",
                [
                    "-T",
                    location(package_file("tests/invalid.ld")),
                    location(":ld-script-object"),
                ],
            ),
        ]
    ]

    # Complete native binutils command set, sharing normal upstream translation units.
    write_file(
        name = "binutils-config.h",
        content = _config_header(config.binutils_on, config.binutils_values),
    )

    generate(
        name = "ar-parser",
        args = [
            "--no-lines",
            "-d",
            "-o",
            "arparse.c",
            location(release("binutils/arparse.y")),
        ],
        chdir = True,
        directory = True,
        env = {"TMPDIR": "."} | action_env,
        files = [
            "arparse.c",
            "arparse.h",
        ],
        tool = tools["bison"],
    )

    generate(
        name = "ar-scanner",
        args = [
            "-L",
            "-t",
            location(release("binutils/arlex.l")),
        ],
        capture = True,
        tool = tools["flex"],
    )

    filegroup(
        name = "binutils-source",
        srcs = {path: release(path) for path in sources.binutils_files + sources.binutils_headers} | {
            "binutils/config.h": ":binutils-config.h",
            "binutils/arparse.c": ":ar-parser[arparse.c]",
            "binutils/arparse.h": ":ar-parser[arparse.h]",
            "binutils/arlex.c": ":ar-scanner",
        },
    )

    BINUTILS_SOURCES = sorted({source: None for program_sources in sources.binutils_programs.values() for source in program_sources})

    [
        c_object(
            name = "bin-" + name + ".o",
            src = ":binutils-source[binutils/" + name + ".c]",
            headers = [
                ":binutils-source",
                ":bfd-source",
                ":zlib-source",
                libc_headers,
            ],
            object_name = "bu{}.o".format(i),
            toolchain = toolchain,
            **source_attrs(
                tree = ":binutils-source",
                # do not sort
                includes = [
                    ":binutils-source[binutils]",
                    ":bfd-source[bfd]",
                    ":binutils-source[include]",
                    ":bfd-source[include]",
                    ":zlib-source[zlib]",
                ],
                logical_source = "binutils/" + name + ".c",
            )
        )
        for i, name in enumerate(BINUTILS_SOURCES)
    ]

    # readelf and elfedit decode ELF without libbfd. readelf links libsframe
    # where the release has it.
    [
        c_binary(
            name = name,
            libraries = ([":libopcodes.a"] if name == "objdump" else []) + ([] if name in [
                "readelf",
                "elfedit",
            ] else [":libbfd.a"]) + ([] if name == "elfedit" else sframe_libraries) + [
                ":libiberty.a",
                ":libz.a",
            ],
            objects = [":bin-" + source + ".o" for source in program_sources],
            output = name,
            runtime = runtime,
            toolchain = toolchain,
        )
        for name, program_sources in sources.binutils_programs.items()
    ]

    [
        command_test(
            name = name + "-version",
            args = ["--version"],
            tool = ":" + name,
        )
        for name in sources.binutils_programs
    ]

    filegroup(
        name = "command-test-tools",
        srcs = {name: ":" + name for name in sources.binutils_programs} | {
            "ld": ":ld",
            "bytecmp": BYTECMP,
        },
    )

    filegroup(
        name = "command-test-input",
        srcs = {"a_native_object_name_longer_than_fifteen.o": ":as-fixture"},
    )

    generate(
        name = "debug-fixture",
        args = [
            "--64",
            "--gdwarf-2",
            location(package_file("tests/debug.s")),
            "-o",
        ],
        output = "debug.o",
        tool = ":as",
    )

    write_file(
        name = "command-test-success",
        content = "ok\n",
    )

    [
        [
            generate(
                name = "command-test-" + name,
                args = [
                    location(package_file("tests/commands.sh")),
                    name,
                    location(":command-test-input[a_native_object_name_longer_than_fifteen.o]"),
                    location(":ld-direct"),
                    location(":debug-fixture"),
                ],
                chdir = True,
                directory = True,
                env = {
                    "PATH": location(":command-test-tools"),
                    "TMPDIR": ".",
                    "LC_ALL": "C",
                } | action_env,
                files = ["result"],
                tool = tools["bash"],
            ),
            compare_test(
                name = "commands-" + name,
                actual = ":command-test-" + name + "[result]",
                expected = ":command-test-success",
            ),
        ]
        for name in [
            "archive",
            "inspect",
            "debug",
            "transform",
            "diagnostics",
        ]
    ]

    # Gprof keeps the native x86 call decoder. Its three explanatory text blocks
    # are generated by the upstream AWK program, using the bootstrapped gawk.
    [
        exact_patch(
            name = name,
            src = source,
            patch = package_file("patches/" + name + ".patch"),
        )
        for name, source in [
            ("gprof-native", release("gprof/corefile.c")),
            ("gprof-bounds", release("gprof/i386.c")),
            ("gprof-displacement", ":gprof-bounds"),
            ("gprof-next-call", ":gprof-displacement"),
        ]
    ]

    [
        generate(
            name = name + ".c",
            args = [
                "-f",
                location(release("gprof/gen-c-prog.awk")),
                "FUNCTION=" + name[:-3] + "_blurb",
                "FILE=" + name + ".m",
                location(release("gprof/" + name + ".m")),
            ],
            capture = True,
            tool = tools["gawk"],
        )
        for name in GPROF_BLURBS
    ]

    write_file(
        name = "gconfig.h",
        content = config.gprof,
    )

    filegroup(
        name = "gprof-source",
        srcs = {path[6:]: release(path) for path in GPROF_FILES} | {
            "gconfig.h": ":gconfig.h",
            "corefile.c": ":gprof-native",
            "i386.c": ":gprof-next-call",
        } | {name + ".c": ":" + name + ".c" for name in GPROF_BLURBS},
    )

    [
        c_object(
            name = "gprof-" + name + ".o",
            src = ":gprof-source[" + name + ".c]",
            defines = [
                "DEBUG=1",
                'LOCALEDIR="/nonexistent-bootstrap-binutils/locale"',
            ],
            headers = [
                ":gprof-source",
                ":bfd-source",
                libc_headers,
            ],
            object_name = "gp{}.o".format(i),
            toolchain = toolchain,
            **source_attrs(
                tree = ":gprof-source",
                # do not sort
                includes = [
                    ":gprof-source",
                    ":bfd-source[bfd]",
                    ":bfd-source[include]",
                ],
                logical_source = name + ".c",
                tree_flags = ["-Isource/."],
            )
        )
        for i, name in enumerate(GPROF + GPROF_BLURBS)
    ]

    c_binary(
        name = "gprof",
        libraries = bfd_libraries,
        objects = [":gprof-" + name + ".o" for name in GPROF + GPROF_BLURBS],
        output = "gprof",
        runtime = runtime,
        toolchain = toolchain,
    )

    command_test(
        name = "gprof-version",
        args = ["--version"],
        tool = ":gprof",
    )

    c_object(
        name = "profile-data.o",
        src = package_file("tests/profile-data.c"),
        flags = cflags,
        headers = [
            ":bfd-source",
            libc_headers,
        ],
        # do not sort
        includes = [
            ":bfd-source[bfd]",
            ":bfd-source[include]",
        ],
        object_name = "profile.o",
        toolchain = toolchain,
    )

    c_binary(
        name = "profile-data",
        libraries = bfd_libraries,
        objects = [":profile-data.o"],
        output = "profile-data",
        runtime = runtime,
        toolchain = toolchain,
    )

    generate(
        name = "profile-object",
        args = [
            "--64",
            location(package_file("tests/profile.s")),
            "-o",
        ],
        output = "profile.o",
        tool = ":as",
    )

    generate(
        name = "profile-program",
        args = [
            "-static",
            location(":profile-object"),
            "-o",
        ],
        output = "profile-program",
        tool = ":ld",
    )

    [
        generate(
            name = "profile-" + name,
            args = [
                location(":profile-program"),
                value,
            ],
            output = "gmon.out",
            tool = ":profile-data",
        )
        for name, value in [
            ("recorded", "1"),
            ("unrecorded", "0"),
        ]
    ]

    [
        [
            generate(
                name = "gprof-test-" + name,
                args = [
                    location(package_file("tests/profile.sh")),
                    name,
                    "$(exe :gprof)",
                    location(":profile-program"),
                    location(":profile-" + ("unrecorded" if name == "backward-call" else "recorded")),
                ],
                chdir = True,
                directory = True,
                env = {
                    "TMPDIR": ".",
                    "LC_ALL": "C",
                    "PATH": "/nonexistent-bootstrap-binutils",
                } | action_env,
                files = ["result"],
                tool = tools["bash"],
            ),
            compare_test(
                name = "gprof-" + name,
                actual = ":gprof-test-" + name + "[result]",
                expected = ":command-test-success",
            ),
        ]
        for name in [
            "counts",
            "backward-call",
            "explanations",
            "diagnostics",
        ]
    ]

    NATIVE_TOOLS = list(sources.binutils_programs) + [
        "as",
        "ld",
        "gprof",
    ]

    filegroup(
        name = "installation",
        srcs = {"bin/" + name: ":" + name for name in NATIVE_TOOLS} | {
            "share/ldscripts/" + name: ":ld-emulation[ldscripts/" + name + "]"
            for name in LD_SCRIPTS
        } | {
            "share/licenses/binutils/" + name: release(name)
            for name in LICENSES
        },
    )

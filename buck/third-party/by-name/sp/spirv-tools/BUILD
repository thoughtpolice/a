# SPDX-FileCopyrightText: © 2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

load("@root//buck/shims:shims.bzl", "shims")
load(
    ":sources.bzl",
    "DIFF_SOURCES",
    "LINK_SOURCES",
    "LINT_SOURCES",
    "OPT_SOURCES",
    "REDUCE_SOURCES",
    "SPIRV_TOOLS_SOURCES",
    "TOOLS_UTIL_SOURCES",
)

# SPIRV-Tools' libraries and command line tools, as its BUILD.bazel and
# CMakeLists.txt define them, with the tables they generate from
# SPIRV-Headers' grammars made by its own Python scripts:
#
#   buck2 run third-party//by-name/sp/spirv-tools:spirv-val -- shader.spv
#
# C++ users link :spirv-tools (libSPIRV-Tools: the assembler, disassembler
# and validator), :spirv-tools-opt, -link, -reduce, -lint or -diff.

GIT_COMMIT = "b8c3b64b63758042576f6853d7f0abe9251460fa"

SPIRV_HEADERS = "third-party//by-name/sp/spirv-headers"

TOOLS = {
    "spirv-as": ["tools/as/as.cpp"],
    "spirv-cfg": [
        "tools/cfg/bin_to_dot.cpp",
        "tools/cfg/cfg.cpp",
    ],
    "spirv-diff": ["tools/diff/diff.cpp"],
    "spirv-dis": ["tools/dis/dis.cpp"],
    "spirv-link": ["tools/link/linker.cpp"],
    "spirv-lint": ["tools/lint/lint.cpp"],
    "spirv-objdump": [
        "tools/objdump/extract_source.cpp",
        "tools/objdump/objdump.cpp",
    ],
    "spirv-opt": ["tools/opt/opt.cpp"],
    "spirv-reduce": ["tools/reduce/reduce.cpp"],
    "spirv-val": ["tools/val/val.cpp"],
}

shims.http_archive(
    name = "src",
    excludes = [
        "^external/",
        "^test/",
    ],
    sha256 = "de63c9d0b6a45322203a4f281b6b967ab1263fd27e0fb8e0db400f42ef2aef1f",
    strip_prefix = "SPIRV-Tools-{}".format(GIT_COMMIT),
    sub_targets = sorted(
        SPIRV_TOOLS_SOURCES + OPT_SOURCES + LINK_SOURCES + REDUCE_SOURCES +
        LINT_SOURCES + DIFF_SOURCES + TOOLS_UTIL_SOURCES +
        [f for files in TOOLS.values() for f in files] + [
            "include/spirv-tools/libspirv.h",
            "include/spirv-tools/libspirv.hpp",
            "include/spirv-tools/linker.hpp",
            "include/spirv-tools/linter.hpp",
            "include/spirv-tools/optimizer.hpp",
            "tools/io.cpp",
        ],
    ),
    type = "tar.gz",
    urls = [
        "https://github.com/KhronosGroup/SPIRV-Tools/archive/{}.tar.gz".format(GIT_COMMIT),
    ],
)

# sources.bzl is what BUILD.bazel's globs find in the source tree; this fails
# when the tree has moved on. To update it after a version bump, run
#
#   cp $(buck2 build --show-simple-output third-party//by-name/sp/spirv-tools:sources.bzl-new) \
#       buck/third-party/by-name/sp/spirv-tools/sources.bzl
shims.python_binary(
    name = "sources-py",
    main = "sources.py",
)

shims.genrule(
    name = "sources.bzl-new",
    out = "sources.bzl",
    cmd = "$(exe :sources-py) $(location :src) > $OUT",
)

shims.export_file(
    name = "sources.bzl-checked-in",
    src = "sources.bzl",
)

shims.command_test(
    name = "sources-up-to-date",
    cmd = [
        "diff",
        "-u",
        "$(location :sources.bzl-checked-in)",
        "$(location :sources.bzl-new)",
    ],
)

# MARK: Generated tables

# A generator script from the archive, run from where it sits so that ggt.py
# finds its utils.Table modules. The genrules below are single commands with
# no shell syntax but $OUT, so that cmd.exe runs them on Windows as bash
# does elsewhere; a genrule with `outs` has $OUT made for it.
GENERATOR = "$(exe root//buck/tools/run-script:run-script) $(location :src)/utils/{}.py"

# source/CMakeLists.txt's grammar tables: the core grammar and the extended
# instruction sets it lists, each with the prefix of its operand enums.
EXTINSTS = [
    ("", "glsl.std.450"),
    ("", "opencl.std.100"),
    ("CLDEBUG100_", "opencl.debuginfo.100"),
    ("SHDEBUG100_", "nonsemantic.shader.debuginfo"),
    ("", "spv-amd-shader-explicit-vertex-parameter"),
    ("", "spv-amd-shader-trinary-minmax"),
    ("", "spv-amd-gcn-shader"),
    ("", "spv-amd-shader-ballot"),
    ("", "debuginfo"),
    ("", "nonsemantic.clspvreflection"),
    ("", "nonsemantic.vkspreflection"),
    ("TOSA_", "tosa.001000.1"),
    ("", "arm.motion-engine.100"),
    ("", "nonsemantic.graph.debuginfo"),
    ("", "arm.experimental-ml-operations"),
    ("", "nonsemantic.debugprintf"),
]

EXTINST_GRAMMAR = "$(location " + SPIRV_HEADERS + ":extinst.{}.grammar.json)"

shims.genrule(
    name = "core-tables",
    outs = {
        "core_tables_body.inc": ["core_tables_body.inc"],
        "core_tables_header.inc": ["core_tables_header.inc"],
    },
    cmd = " ".join([
        GENERATOR.format("ggt"),
        "--spirv-core-grammar=$(location {}:spirv.core.grammar.json)".format(SPIRV_HEADERS),
        "--core-tables-body-output=$OUT/core_tables_body.inc",
        "--core-tables-header-output=$OUT/core_tables_header.inc",
    ] + [
        "--extinst={},{}".format(
            prefix,
            EXTINST_GRAMMAR.format(name),
        )
        for prefix, name in EXTINSTS
    ]),
)

# The C enums of two extended instruction sets, which SPIRV-Tools includes
# as "DebugInfo.h" and "OpenCLDebugInfo100.h".
LANGUAGE_HEADERS = {
    "DebugInfo": "debuginfo",
    "OpenCLDebugInfo100": "opencl.debuginfo.100",
}

[
    shims.genrule(
        name = header + ".h",
        out = header + ".h",
        cmd = GENERATOR.format("generate_language_headers") + " --extinst-grammar={} --extinst-output-path=$OUT".format(
            EXTINST_GRAMMAR.format(grammar),
        ),
    )
    for header, grammar in LANGUAGE_HEADERS.items()
]

# The generator IDs of tools that write SPIR-V, from the registry.
shims.genrule(
    name = "generators.inc",
    out = "generators.inc",
    cmd = GENERATOR.format("generate_registry_tables") + " --xml=$(location {}:spir-v.xml) --generator-output=$OUT".format(
        SPIRV_HEADERS,
    ),
)

# The version the tools report: CHANGES's latest release and, in place of
# `git describe` (which would find this repository instead), the commit.
shims.genrule(
    name = "build-version.inc",
    out = "build-version.inc",
    cmd = " ".join([
        GENERATOR.format("update_build_version"),
        "$(location :src)/CHANGES",
        "$OUT",
    ]),
    env = {
        "FORCED_BUILD_VERSION_DESCRIPTION": "v2026.4-78-g{}".format(GIT_COMMIT[:8]),
        "SOURCE_DATE_EPOCH": "0",
    },
)

shims.cxx_library(
    name = "generated",
    exported_headers = {
        "DebugInfo.h": ":DebugInfo.h",
        "OpenCLDebugInfo100.h": ":OpenCLDebugInfo100.h",
        "build-version.inc": ":build-version.inc",
        "core_tables_body.inc": ":core-tables[core_tables_body.inc]",
        "core_tables_header.inc": ":core-tables[core_tables_header.inc]",
        "generators.inc": ":generators.inc",
    },
    header_namespace = "",
)

# MARK: Libraries

# build_defs.bzl's COMMON_COPTS for a Unix host. Sources include each other
# as "source/..." from the top of the tree, and the public headers as
# "spirv-tools/...".
#
# On Windows, where COMMON_COPTS leaves the platform to Bazel's MSVC
# toolchain, CMakeLists.txt's configuration for MSVC (which clang-cl's
# flags follow): SPIRV_WINDOWS, which gives the tools binary stdin and
# stdout and the console its colors; the CRT's deprecation warnings off;
# and C++ exceptions on (ENABLE_EXCEPTIONS_ON_MSVC, the default), with
# RTTI, which only GCC-like compilers have turned off. Timers are Linux's
# clock_gettime().
COMPILER_FLAGS = shims.select({
    "config//os:windows": ["/EHsc"],
    "DEFAULT": [
        "-fvisibility=hidden",
        "-fno-exceptions",
        "-fno-rtti",
    ],
})

PREPROCESSOR_FLAGS = [
    "-DSPIRV_CHECK_CONTEXT",
    "-DSPIRV_COLOR_TERMINAL",
    "-I$(location :src)",
] + shims.select({
    "config//os:windows": [
        "-DSPIRV_WINDOWS",
        "-D_CRT_SECURE_NO_WARNINGS",
        "-D_SCL_SECURE_NO_WARNINGS",
    ],
    "DEFAULT": [
        "-DSPIRV_LINUX",
        "-DSPIRV_TIMER_ENABLED",
    ],
})

LIBRARIES = {
    "spirv-tools": (
        SPIRV_TOOLS_SOURCES,
        [
            ":generated",
            SPIRV_HEADERS + ":spirv-headers",
        ],
    ),
    "spirv-tools-opt": (
        OPT_SOURCES,
        [":spirv-tools"],
    ),
    "spirv-tools-link": (
        LINK_SOURCES,
        [":spirv-tools-opt"],
    ),
    "spirv-tools-reduce": (
        REDUCE_SOURCES,
        [":spirv-tools-opt"],
    ),
    "spirv-tools-lint": (
        LINT_SOURCES,
        [":spirv-tools-opt"],
    ),
    "spirv-tools-diff": (
        DIFF_SOURCES,
        [":spirv-tools-opt"],
    ),
}

[
    shims.cxx_library(
        name = name,
        srcs = [":src[{}]".format(f) for f in srcs],
        compiler_flags = COMPILER_FLAGS,
        # Every library's headers, the generated ones included, are reached
        # through the others', so the dependency chain is exported.
        exported_deps = deps,
        exported_preprocessor_flags = [
            "-I$(location :src)/include",
        ],
        preferred_linkage = "static",
        preprocessor_flags = PREPROCESSOR_FLAGS,
        visibility = ["PUBLIC"],
    )
    for name, (srcs, deps) in LIBRARIES.items()
]

shims.cxx_library(
    name = "tools-util",
    srcs = [":src[{}]".format(f) for f in TOOLS_UTIL_SOURCES + ["tools/io.cpp"]],
    compiler_flags = COMPILER_FLAGS,
    preferred_linkage = "static",
    preprocessor_flags = PREPROCESSOR_FLAGS,
    deps = [":spirv-tools"],
)

# MARK: Tools

TOOL_DEPS = {
    "spirv-diff": [":spirv-tools-diff"],
    "spirv-link": [":spirv-tools-link"],
    "spirv-lint": [":spirv-tools-lint"],
    "spirv-objdump": [":spirv-tools-opt"],
    "spirv-opt": [":spirv-tools-opt"],
    "spirv-reduce": [":spirv-tools-reduce"],
}

[
    shims.cxx_binary(
        name = name,
        srcs = [":src[{}]".format(f) for f in srcs],
        compiler_flags = COMPILER_FLAGS,
        link_style = "static",
        preprocessor_flags = PREPROCESSOR_FLAGS,
        visibility = ["PUBLIC"],
        deps = [
            ":spirv-tools",
            ":tools-util",
        ] + TOOL_DEPS.get(name, []),
    )
    for name, srcs in TOOLS.items()
]

# MARK: Tests

shims.export_file(
    name = "add.spvasm",
    src = "tests/add.spvasm",
)

shims.export_file(
    name = "invalid.spvasm",
    src = "tests/invalid.spvasm",
)

[
    shims.command_test(
        name = "test-{}-version".format(name),
        script = """
            $(exe :{}) --version 2>&1 | grep -q "SPIRV-Tools v2026.4 v2026.4-78-g{}"
        """.format(
            name,
            GIT_COMMIT[:8],
        ),
    )
    for name in [
        "spirv-as",
        "spirv-dis",
        "spirv-link",
        "spirv-opt",
        "spirv-val",
    ]
]

# Assemble, validate, optimize and disassemble a module; link it with itself
# renamed; and look at it with the other tools. The optimizer must fold the
# constant addition away.
shims.command_test(
    name = "test-tool-suite",
    script = """
        out=${TMPDIR:-/tmp}/spirv-tools-$$
        mkdir -p $out
        trap 'rm -rf $out' EXIT

        $(exe :spirv-as) $(location :add.spvasm) -o $out/add.spv
        $(exe :spirv-val) $out/add.spv
        $(exe :spirv-dis) $out/add.spv -o $out/add.dis
        grep -q 'OpIAdd' $out/add.dis

        $(exe :spirv-opt) -O $out/add.spv -o $out/opt.spv
        $(exe :spirv-val) $out/opt.spv
        $(exe :spirv-dis) $out/opt.spv -o $out/opt.dis
        if grep -q 'OpIAdd' $out/opt.dis; then
            echo "spirv-opt -O left the constant addition in" >&2
            exit 1
        fi
        grep -q 'OpConstant %uint 5' $out/opt.dis

        $(exe :spirv-link) --create-library $out/add.spv -o $out/lib.spv
        $(exe :spirv-val) $out/lib.spv
        $(exe :spirv-cfg) $out/add.spv -o $out/add.dot
        grep -q 'digraph' $out/add.dot
        $(exe :spirv-lint) $out/add.spv
        # The only dump spirv-objdump implements: debug info's source files,
        # of which this module has none.
        $(exe :spirv-objdump) --source --list $out/add.spv
        $(exe :spirv-diff) $out/add.spv $out/opt.spv > $out/diff.txt || true
        grep -q 'OpIAdd' $out/diff.txt
    """,
)

shims.command_test(
    name = "test-invalid",
    script = """
        out=${TMPDIR:-/tmp}/spirv-tools-invalid-$$
        mkdir -p $out
        trap 'rm -rf $out' EXIT
        $(exe :spirv-as) $(location :invalid.spvasm) -o $out/invalid.spv
        if $(exe :spirv-val) $out/invalid.spv 2>$out/err; then
            echo "spirv-val accepted an invalid module" >&2
            exit 1
        fi
        grep -q 'error' $out/err
    """,
)

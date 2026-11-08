# SPDX-FileCopyrightText: © 2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

load("@root//buck/shims:package.bzl", "pkg")
load("@root//buck/shims:shims.bzl", "shims")
load(
    ":build.bzl",
    "SLANG_COMPILER_FLAGS",
    "SLANG_DEFINES",
    "SLANG_DYNAMIC_EXPORT",
    "configure_file",
    "custom_command",
    "host_sources",
    "install_tree",
    "per_os",
    "slang_library",
    "src",
)
load(
    ":sources.bzl",
    "CAPABILITY_DEFS",
    "COMPILER_CORE_SOURCES",
    "CORE_MODULE_META",
    "CORE_SOURCES",
    "FIDDLE_INPUTS",
    "GENERATOR_SOURCES",
    "PRELUDES",
    "PUBLIC_HEADERS",
    "SLANG_SOURCES",
)

# The Slang compiler, built from the release tarball with Slang's CMake build
# replaced by this file:
#
#   buck2 run third-party//by-name/sl/slang:slangc -- shader.slang -target spirv -o shader.spv
#
# runs slangc from :dist, the install tree, where it finds libslang-compiler
# and the modules it loads beside it as it would in a release. C++ users of
# the API depend on :slang.
#
# Slang builds itself in three stages, as source/slang-core-module and
# tools/CMakeLists.txt arrange them:
#
#   1. Generator tools, linked against source/core and source/compiler-core,
#      write C++ from Slang's data files: slang-fiddle (IR instruction and
#      AST tables, from Lua templates in the headers), the capability tables,
#      the SPIR-V grammar tables, the prelude strings, and the core module
#      source as C++ string literals.
#   2. slang-bootstrap, slangc linked with a compiler that has no core module
#      built in, compiles the core and GLSL modules and serializes them.
#   3. libslang-compiler is the same compiler objects with the serialized
#      core module embedded; libslang-glsl-module holds the GLSL one.
#
# Beside them, libslang-glslang wraps glslang and SPIRV-Tools: the SPIR-V
# optimizer, validator, linker and disassembler slangc runs after its own
# SPIR-V emitter, and GLSL-to-SPIR-V for -emit-spirv-via-glsl.
#
# This matches a default CMake configuration on Linux, macOS and Windows,
# minus everything that needs LLVM (slang-llvm), a GPU (gfx, slang-rhi) or
# the finished compiler (the standard modules, slangd, slangi, tests and
# examples), and on Windows the slang.dll that forwards to
# slang-compiler.dll for programs built against its old name
# (SLANG_ENABLE_SLANG_PROXY). sources.bzl lists the sources CMake's globs
# would find; see sources.py. The generators run through build.bzl's rules
# rather than a shell, so that the build runs on each of those hosts.

VERSION = pkg.version()

# MARK: Sources

# The prelude, slang-generate and capability inputs are read by the build
# steps below through $(location :src), not as sub-targets.
shims.http_archive(
    name = "src",
    excludes = [
        "^examples/",
        "^extras/",
        "^tests/",
    ],
    sha256 = "7b9ede47b8d02108c3cec0b5924f4e9ad86c6b0ec9cf55706cbe3b95cb0a84ac",
    strip_prefix = "slang-{}".format(VERSION),
    sub_targets = sorted(
        CORE_SOURCES +
        COMPILER_CORE_SOURCES +
        SLANG_SOURCES +
        [source for sources in GENERATOR_SOURCES.values() for source in sources] +
        ["include/{}".format(h) for h in PUBLIC_HEADERS] + [
            "docs/user-guide/a4-02-reference-capability-atoms.md",
            "slang-tag-version.h.in",
            "source/slang-core-module/slang-embedded-core-module-source.cpp",
            "source/slang-core-module/slang-embedded-core-module.cpp",
            "source/slang-glsl-module/slang-embedded-glsl-module.cpp",
            "source/slang-glslang/slang-glslang.cpp",
            "source/slang-glslang/slang-glslang.version-script",
            "source/slangc/main.cpp",
            "source/standard-modules/slang-standard-module-config.h.in",
        ],
    ),
    type = "tar.gz",
    urls = [
        "https://github.com/shader-slang/slang/archive/refs/tags/v{}.tar.gz".format(VERSION),
    ],
)

# sources.bzl is what Slang's CMake globs find in the source tree; this
# fails when the tree has moved on. To update it after a version bump or a
# change to sources.py, run
#
#   cp $(buck2 build --show-simple-output third-party//by-name/sl/slang:sources.bzl-new) \
#       buck/third-party/by-name/sl/slang/sources.bzl
shims.python_binary(
    name = "sources-py",
    main = "sources.py",
)

# The build steps of build.bzl's rules.
shims.python_binary(
    name = "step",
    main = "step.py",
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

# MARK: core, compiler-core

# The include directories source/core makes public: source/ for
# "core/...", "compiler-core/..." and the like, and include/ for slang.h.
# The whole tree is named rather than its headers, so that every header is an
# input of every compile.
#
# Threads::Threads and CMAKE_DL_LIBS, which it links, are the C library
# itself on Windows.
slang_library(
    name = "core",
    srcs = host_sources(CORE_SOURCES),
    exported_deps = ["third-party//by-name/un/unordered-dense:unordered-dense"],
    exported_linker_flags = shims.select({
        "config//os:windows": [],
        "DEFAULT": [
            "-ldl",
            "-pthread",
        ],
    }),
    exported_preprocessor_flags = [
        "-I$(location :src)/source",
        "-I$(location :src)/include",
        "-DSLANG_STATIC",
    ],
    deps = [
        "third-party//by-name/lz/lz4:lz4",
        "third-party//by-name/mi/miniz:miniz",
    ],
)

# slang-dxc-compiler.cpp includes DXC's COM-style dxcapi.h, which needs
# Microsoft extensions outside MSVC; clang-cl has them on.
slang_library(
    name = "compiler-core",
    srcs = host_sources(
        COMPILER_CORE_SOURCES,
        flags = {
            "slang-dxc-compiler.cpp": {
                "config//os:windows": [],
                "DEFAULT": ["-fms-extensions"],
            },
        },
    ),
    exported_deps = ["third-party//by-name/sp/spirv-headers:spirv-headers"],
    exported_preprocessor_flags = ["-DSLANG_STATIC"],
    preprocessor_flags = ["-I$(location :src)/external"],
    deps = [
        "third-party//by-name/fa/fast-float:fast-float",
        ":core",
        ":version-header",
    ],
)

# MARK: Configured headers

# CMake's configure_file() of the two .h.in templates. The version is what
# cmake/GitVersion.cmake reads from cmake/slang_git_version in a release
# tarball, "v" removed.
configure_file(
    name = "slang-tag-version.h",
    src = src("slang-tag-version.h.in"),
    out = "slang-tag-version.h",
    values = {
        "SLANG_VERSION_FULL": VERSION,
        "SLANG_VERSION_NUMERIC": VERSION,
    },
)

shims.cxx_library(
    name = "version-header",
    exported_headers = {
        "slang-tag-version.h": ":slang-tag-version.h",
    },
    header_namespace = "",
)

# source/standard-modules/CMakeLists.txt's defaults, whose install
# directory is beside the libraries: bin/ on Windows, lib/ elsewhere. The
# standard modules themselves are not built, so the directory it names
# stays empty.
STANDARD_MODULE_DIR = "slang-standard-module-{}".format(VERSION)

configure_file(
    name = "slang-standard-module-config.h",
    src = src("source/standard-modules/slang-standard-module-config.h.in"),
    out = "slang-standard-module-config.h",
    values = shims.select({
        os: {
            "SLANG_DISABLE_NOTE_IDS": "",
            "SLANG_NEURAL_MODULE_FILE_NAME": "neural.slang-module",
            "SLANG_STANDARD_MODULE_DIR_NAME": STANDARD_MODULE_DIR,
            "SLANG_STANDARD_MODULE_INSTALL_DIR": "{}/{}".format(library_dir, STANDARD_MODULE_DIR),
            "SLANG_WORKGRAPH_MODULE_FILE_NAME": "workgraph.slang-module",
        }
        for os, library_dir in {
            "config//os:linux": "lib",
            "config//os:macos": "lib",
            "config//os:windows": "bin",
        }.items()
    }),
)

shims.cxx_library(
    name = "standard-module-config",
    exported_headers = {
        "slang-standard-module-config.h": ":slang-standard-module-config.h",
    },
    header_namespace = "",
)

# MARK: Generators

# tools/CMakeLists.txt's generator() executables. slang-fiddle uses the Lua
# package rather than the copy Slang vendors, as with SLANG_USE_SYSTEM_LUA.
GENERATOR_DEPS = {
    "slang-capability-generator": [":compiler-core"],
    "slang-embed": [],
    "slang-fiddle": [
        ":compiler-core",
        "third-party//by-name/lu/lua:liblua",
    ],
    "slang-generate": [],
    "slang-lookup-generator": [":compiler-core"],
    "slang-spirv-embed-generator": [":compiler-core"],
}

[
    shims.cxx_binary(
        name = name,
        srcs = host_sources([
            f
            for f in GENERATOR_SOURCES[name]
            if not f.endswith("/slang-fiddle-lua.cpp")
        ]),
        compiler_flags = SLANG_COMPILER_FLAGS,
        link_style = "static",
        preprocessor_flags = SLANG_DEFINES + (
            ["-DSLANG_USE_SYSTEM_LUA=1"] if name == "slang-fiddle" else []
        ),
        deps = [":core"] + deps,
    )
    for name, deps in GENERATOR_DEPS.items()
]

# MARK: Generated sources

# source/slang/CMakeLists.txt's fiddle step, run from the top of a copy of
# source/, where the templates' require()s look for their Lua modules and
# the diagnostic scripts for the other libraries' diagnostic tables.
# slang-fiddle also rewrites an input whose template output has changed;
# a release's inputs should already be current, and the step fails if one
# is not, since the compile reads the archive's copy.
custom_command(
    name = "fiddle",
    cmds = [
        [
            "$(exe :slang-fiddle)",
            "-i",
            "source/slang/",
            "-o",
            "$OUT/",
        ] + FIDDLE_INPUTS,
    ],
    scratch = {
        "source": "$(location :src)/source",
    },
    unchanged = ["source"],
    working_directory = "$SCRATCH",
)

shims.cxx_library(
    name = "fiddle-output",
    exported_preprocessor_flags = ["-I$(location :fiddle)"],
)

# The capability tables, generated from source/slang as CMake runs it. The
# generator also rewrites the capability atom reference in docs/, so it is
# given a scratch copy.
CAPABILITY_HEADERS = [
    "slang-generated-capability-defs-impl.h",
    "slang-generated-capability-defs.h",
]

custom_command(
    name = "capability",
    outs = CAPABILITY_HEADERS + ["slang-lookup-capability-defs.cpp"],
    cmds = [
        ["$(exe :slang-capability-generator)"] + CAPABILITY_DEFS + [
            "--target-directory",
            "$OUT",
            "--doc",
            "$SCRATCH/capability-atoms.md",
        ],
    ],
    scratch = {
        "capability-atoms.md": "$(location {})".format(src("docs/user-guide/a4-02-reference-capability-atoms.md")),
    },
    working_directory = "$(location :src)/source/slang",
)

# slang-capability-defs: the generated headers, and source/slang, which
# CMake makes public with them and which the compiler's headers expect.
shims.cxx_library(
    name = "capability-defs",
    exported_headers = {
        f: ":capability[{}]".format(f)
        for f in CAPABILITY_HEADERS
    },
    exported_preprocessor_flags = ["-I$(location :src)/source/slang"],
    header_namespace = "",
)

slang_library(
    name = "capability-lookup",
    srcs = [":capability[slang-lookup-capability-defs.cpp]"],
    preprocessor_flags = SLANG_DYNAMIC_EXPORT,
    deps = [
        ":capability-defs",
        ":core",
    ],
)

# The GLSL.std.450 name table and the embedded SPIR-V core grammar.
custom_command(
    name = "lookup-tables-sources",
    outs = [
        "slang-lookup-GLSLstd450.cpp",
        "slang-spirv-core-grammar-embed.cpp",
    ],
    cmds = [
        [
            "$(exe :slang-lookup-generator)",
            "$(location third-party//by-name/sp/spirv-headers:extinst.glsl.std.450.grammar.json)",
            "$OUT/slang-lookup-GLSLstd450.cpp",
            "GLSLstd450",
            "GLSLstd450",
            "spirv/unified1/GLSL.std.450.h",
        ],
        [
            "$(exe :slang-spirv-embed-generator)",
            "$(location third-party//by-name/sp/spirv-headers:spirv.core.grammar.json)",
            "$OUT/slang-spirv-core-grammar-embed.cpp",
        ],
    ],
)

slang_library(
    name = "lookup-tables",
    srcs = [
        ":lookup-tables-sources[slang-lookup-GLSLstd450.cpp]",
        ":lookup-tables-sources[slang-spirv-core-grammar-embed.cpp]",
    ],
    preprocessor_flags = SLANG_DYNAMIC_EXPORT,
    deps = [
        "third-party//by-name/sp/spirv-headers:spirv-headers",
        ":core",
    ],
)

# prelude/CMakeLists.txt: each *-prelude.h as a C++ string, with the
# includes slang-embed can find (core's include directories) inlined.
custom_command(
    name = "prelude-sources",
    outs = [p + ".cpp" for p in PRELUDES],
    cmds = [
        [
            "$(exe :slang-embed)",
            "$(location :src)/prelude/" + p,
            "$OUT/{}.cpp".format(p),
            "-I$(location :src)/source",
            "-I$(location :src)/include",
        ]
        for p in PRELUDES
    ],
)

slang_library(
    name = "prelude",
    srcs = [":prelude-sources[{}.cpp]".format(p) for p in PRELUDES],
    exported_preprocessor_flags = [
        "-I$(location :src)/prelude",
        "-I$(location :src)/include",
    ],
    preprocessor_flags = SLANG_DYNAMIC_EXPORT,
    deps = ["third-party//by-name/un/unordered-dense:unordered-dense"],
)

# source/slang-core-module's slang-generate step: the core module's
# *.meta.slang, which mix Slang with C++ that generates more of it, as C++,
# run from their directory as CMake does.
custom_command(
    name = "core-module-meta",
    outs = [m + ".h" for m in CORE_MODULE_META],
    cmds = [
        ["$(exe :slang-generate)"] + CORE_MODULE_META + [
            "--target-directory",
            "$OUT",
        ],
    ],
    working_directory = "$(location :src)/source/slang",
)

shims.cxx_library(
    name = "core-module-meta-headers",
    exported_headers = {
        m + ".h": ":core-module-meta[{}.h]".format(m)
        for m in CORE_MODULE_META
    },
    header_namespace = "",
)

# MARK: Compiler

# slang-common-objects: the compiler itself, with the API record-replay
# layer, linked whole into slang-bootstrap and libslang-compiler.
slang_library(
    name = "slang-objects",
    srcs = host_sources(
        SLANG_SOURCES,
        flags = {
            # CMake builds the rich diagnostic tables for size, with MSVC's
            # spellings under clang-cl.
            "slang-rich-diagnostics.cpp": {
                "config//os:windows": [
                    "/O1",
                    "/Os",
                ],
                "DEFAULT": ["-Oz"],
            },
        },
    ),
    link_whole = True,
    preprocessor_flags = SLANG_DYNAMIC_EXPORT + [
        "-DSLANG_ENABLE_RECORD_REPLAY=1",
        "-I$(location :src)/tools",
    ],
    deps = [
        "third-party//by-name/sw/swift-cmark:swift-cmark",
        ":capability-defs",
        ":capability-lookup",
        ":compiler-core",
        ":core",
        ":fiddle-output",
        ":lookup-tables",
        ":prelude",
        ":standard-module-config",
        ":version-header",
    ],
)

# The core module's source, as slang-generate wrote it: the bootstrap
# compiles it, and the finished compiler keeps it for its documentation and
# language server queries.
slang_library(
    name = "core-module-source",
    srcs = [src("source/slang-core-module/slang-embedded-core-module-source.cpp")],
    link_whole = True,
    preprocessor_flags = SLANG_DYNAMIC_EXPORT + [
        "-DSLANG_EMBED_CORE_MODULE_SOURCE",
    ],
    deps = [
        "third-party//by-name/sp/spirv-headers:spirv-headers",
        ":capability-defs",
        ":core",
        ":core-module-meta-headers",
        ":fiddle-output",
    ],
)

slang_library(
    name = "no-embedded-core-module",
    srcs = [src("source/slang-core-module/slang-embedded-core-module.cpp")],
    link_whole = True,
    preprocessor_flags = SLANG_DYNAMIC_EXPORT,
    deps = [":core"],
)

# Stage 2: slangc with SLANG_BOOTSTRAP, which builds the core module from
# source instead of loading an embedded one.
shims.cxx_binary(
    name = "slang-bootstrap",
    srcs = [src("source/slangc/main.cpp")],
    compiler_flags = SLANG_COMPILER_FLAGS,
    link_style = "static",
    preprocessor_flags = SLANG_DEFINES + ["-DSLANG_BOOTSTRAP=1"],
    deps = [
        ":core",
        ":core-module-source",
        ":no-embedded-core-module",
        ":slang-objects",
    ],
)

CORE_MODULE_OUTPUTS = [
    "slang-core-module-generated.h",
    "slang-glsl-module-generated.h",
    "slang-core-module.bin",
]

custom_command(
    name = "core-module",
    outs = CORE_MODULE_OUTPUTS,
    cmds = [
        [
            "$(exe :slang-bootstrap)",
            "-compile-core-module",
            "-archive-type",
            "riff-lz4",
            "-save-core-module",
            "$OUT/slang-core-module.bin",
            "-save-core-module-bin-source",
            "$OUT/slang-core-module-generated.h",
            "-save-glsl-module-bin-source",
            "$OUT/slang-glsl-module-generated.h",
        ],
    ],
)

shims.cxx_library(
    name = "core-module-headers",
    exported_headers = {
        f: ":core-module[{}]".format(f)
        for f in CORE_MODULE_OUTPUTS
        if f.endswith(".h")
    },
    header_namespace = "",
)

# The shared libraries, named, linked and laid out as CMake does on each
# platform: the names are their sonames on Linux, their install names (under
# @rpath) on macOS, and their DLL names on Windows, where the modules carry
# no version (slang-api.cpp and slang-glslang-compiler.cpp look them up so).
# `dev` and `legacy` are the names libslang-compiler is also installed
# under, beside it in `library_dir`. Each finds the modules it loads by name
# beside it: through an rpath of its own directory, $ORIGIN or Mach-O's
# @loader_path, and on Windows, which has no rpath, by installing everything
# in bin/ beside slangc, where the DLL search looks first. Mach-O links
# refuse undefined symbols unasked, and take a list of the symbols to export
# where ELF ones take a version script; a DLL exports what its source
# declares dllexport, and nothing else.
LIBRARIES = {
    "config//os:linux": struct(
        compiler = "libslang-compiler.so.0.{}".format(VERSION),
        compiler_linker_flags = ["-Wl,--build-id"],
        dev = "libslang-compiler.so",
        glsl_module = "libslang-glsl-module-{}.so".format(VERSION),
        glslang = "libslang-glslang-{}.so".format(VERSION),
        glslang_linker_flags = [
            "-Wl,--version-script=$(location {})".format(src("source/slang-glslang/slang-glslang.version-script")),
        ],
        legacy = "libslang.so",
        library_dir = "lib",
        linker_flags = ["-Wl,--no-undefined"],
        # Symbols of the static libraries linked in stay hidden.
        module_linker_flags = ["-Wl,--exclude-libs,ALL"],
        rpath = ["-Wl,-rpath,$ORIGIN"],
        slangc = "slangc",
        slangc_rpath = ["-Wl,-rpath,$ORIGIN/../lib"],
    ),
    "config//os:macos": struct(
        compiler = "libslang-compiler.0.{}.dylib".format(VERSION),
        compiler_linker_flags = [],
        dev = "libslang-compiler.dylib",
        glsl_module = "libslang-glsl-module-{}.dylib".format(VERSION),
        glslang = "libslang-glslang-{}.dylib".format(VERSION),
        glslang_linker_flags = [
            "-Wl,-exported_symbols_list,$(location :slang-glslang.exports)",
        ],
        legacy = "libslang.dylib",
        library_dir = "lib",
        linker_flags = [],
        module_linker_flags = [],
        rpath = ["-Wl,-rpath,@loader_path"],
        slangc = "slangc",
        slangc_rpath = ["-Wl,-rpath,@loader_path/../lib"],
    ),
    "config//os:windows": struct(
        compiler = "slang-compiler.dll",
        compiler_linker_flags = [],
        dev = None,
        glsl_module = "slang-glsl-module.dll",
        glslang = "slang-glslang.dll",
        glslang_linker_flags = [],
        legacy = None,
        library_dir = "bin",
        linker_flags = [],
        module_linker_flags = [],
        rpath = [],
        slangc = "slangc.exe",
        slangc_rpath = [],
    ),
}

# The names slang-glslang's version script exports, as Mach-O spells them.
shims.genrule(
    name = "slang-glslang.exports",
    out = "slang-glslang.exports",
    cmd = "sed -n -e '/global:/,/local:/s/^ *\\([A-Za-z0-9_]*\\);$/_\\1/p' $(location {}) > $OUT".format(
        src("source/slang-glslang/slang-glslang.version-script"),
    ),
    compatible_with = ["config//os:macos"],
)

# Stage 3: libslang-compiler, the library slangc and API users link: the
# compiler objects, and as its own source the embedded core module (which
# is also what gives Buck objects to make a shared library of). Its rpath
# lets it dlopen() the GLSL module installed beside it.
shims.cxx_library(
    name = "slang",
    srcs = [src("source/slang-core-module/slang-embedded-core-module.cpp")],
    compiler_flags = SLANG_COMPILER_FLAGS,
    exported_headers = {
        h: src("include/" + h)
        for h in PUBLIC_HEADERS
    } | {
        "slang-tag-version.h": ":slang-tag-version.h",
    },
    exported_preprocessor_flags = ["-DSLANG_DYNAMIC"],
    header_namespace = "",
    linker_flags = per_os(LIBRARIES, "linker_flags") + per_os(LIBRARIES, "compiler_linker_flags") + per_os(LIBRARIES, "rpath"),
    preferred_linkage = "shared",
    preprocessor_flags = SLANG_DEFINES + SLANG_DYNAMIC_EXPORT + ["-DSLANG_EMBED_CORE_MODULE"],
    soname = per_os(LIBRARIES, "compiler"),
    deps = [
        ":core",
        ":core-module-headers",
        ":core-module-source",
        ":slang-objects",
    ],
)

# source/slang-glsl-module: the serialized GLSL module, which the compiler
# loads by name when a program needs it.
shims.cxx_library(
    name = "slang-glsl-module",
    srcs = [src("source/slang-glsl-module/slang-embedded-glsl-module.cpp")],
    compiler_flags = SLANG_COMPILER_FLAGS,
    linker_flags = per_os(LIBRARIES, "linker_flags") + per_os(LIBRARIES, "module_linker_flags"),
    preferred_linkage = "shared",
    preprocessor_flags = SLANG_DEFINES + ["-DSLANG_SHARED_LIBRARY_TOOL"],
    soname = per_os(LIBRARIES, "glsl_module"),
    deps = [
        ":core",
        ":core-module-headers",
        ":version-header",
    ],
)

# source/slang-glslang: glslang and SPIRV-Tools linked into a module the
# compiler loads by name when it needs them. It exports only the entry
# points Slang looks up, as its version script names them. CMake asks for
# -fno-rtti where the compiler takes it, which neither MSVC nor clang-cl
# does, so on Windows it keeps RTTI.
shims.cxx_library(
    name = "slang-glslang",
    srcs = [src("source/slang-glslang/slang-glslang.cpp")],
    compiler_flags = SLANG_COMPILER_FLAGS + shims.select({
        "config//os:windows": [],
        "DEFAULT": ["-fno-rtti"],
    }),
    linker_flags = per_os(LIBRARIES, "linker_flags") + per_os(LIBRARIES, "module_linker_flags") + per_os(LIBRARIES, "glslang_linker_flags"),
    preferred_linkage = "shared",
    preprocessor_flags = SLANG_DEFINES + [
        "-I$(location :src)/source",
        "-I$(location :src)/include",
    ],
    soname = per_os(LIBRARIES, "glslang"),
    deps = [
        "third-party//by-name/gl/glslang:glslang",
        "third-party//by-name/sp/spirv-tools:spirv-tools-link",
        "third-party//by-name/un/unordered-dense:unordered-dense",
        ":version-header",
    ],
)

shims.cxx_binary(
    name = "slangc-bin",
    srcs = [src("source/slangc/main.cpp")],
    compiler_flags = SLANG_COMPILER_FLAGS,
    link_style = "shared",
    linker_flags = per_os(LIBRARIES, "slangc_rpath"),
    preprocessor_flags = SLANG_DEFINES,
    deps = [
        ":core",
        ":slang",
    ],
)

# MARK: Install tree

# The layout of a release: bin/slangc, which finds the libraries through its
# rpath or beside it, libslang-compiler with its development and legacy
# libslang names, the modules it loads beside it, and the API headers.
# `buck2 run :dist` (or :slangc) runs the slangc in it.
install_tree(
    name = "dist",
    executable = "bin/" + per_os(LIBRARIES, "slangc"),
    files = shims.select({
        os: {
            "bin/" + names.slangc: ":slangc-bin",
            "{}/{}".format(
                names.library_dir,
                names.compiler,
            ): ":slang[shared]",
            "{}/{}".format(
                names.library_dir,
                names.glsl_module,
            ): ":slang-glsl-module[shared]",
            "{}/{}".format(
                names.library_dir,
                names.glslang,
            ): ":slang-glslang[shared]",
            "include/slang-tag-version.h": ":slang-tag-version.h",
        } | {
            "include/" + h: src("include/" + h)
            for h in PUBLIC_HEADERS
        }
        for os, names in LIBRARIES.items()
    }),
    symlinks = shims.select({
        os: {
            "{}/{}".format(
                names.library_dir,
                names.dev,
            ): names.compiler,
            "{}/{}".format(
                names.library_dir,
                names.legacy,
            ): names.dev,
        } if names.dev else {}
        for os, names in LIBRARIES.items()
    }),
    visibility = ["PUBLIC"],
)

shims.command(
    name = "slangc",
    dep = ":dist",
    visibility = ["PUBLIC"],
)

# MARK: Tests

[
    shims.export_file(
        name = f,
        src = "tests/" + f,
    )
    for f in [
        "api.cpp",
        "double.comp",
        "scale.slang",
    ]
]

shims.command_test(
    name = "test-version",
    script = """
        test "`$(exe :slangc) -version 2>&1`" = "{}"
    """.format(VERSION),
)

SPIRV_VAL = "$(exe third-party//by-name/sp/spirv-tools:spirv-val)"

# One shader to SPIR-V by each of slangc's routes, every result checked by
# SPIRV-Tools' validator: emitted directly, without and with spirv-opt (the
# default, -O1), and through GLSL and glslang; then to every source target,
# whose output must name what the shader declared.
shims.command_test(
    name = "test-targets",
    script = """
        slangc=$(exe :slangc)
        val={val}
        shader=$(location :scale.slang)
        out=${{TMPDIR:-/tmp}}/slang-targets-$$
        mkdir -p $out
        trap 'rm -rf $out' EXIT

        $slangc $shader -target spirv -O0 -o $out/scale-o0.spv
        $slangc $shader -target spirv -o $out/scale.spv
        $slangc $shader -target spirv -O3 -o $out/scale-o3.spv
        $slangc $shader -target spirv -emit-spirv-via-glsl -entry computeMain -stage compute -o $out/scale-glsl.spv
        for spv in $out/*.spv; do
            $val $spv
        done

        $slangc $shader -target spirv-asm -o $out/scale.spvasm
        grep -q 'OpEntryPoint GLCompute %computeMain "main"' $out/scale.spvasm
        grep -q 'OpExecutionMode %computeMain LocalSize 64 1 1' $out/scale.spvasm

        for target in hlsl glsl metal wgsl cuda cpp; do
            $slangc $shader -target $target -entry computeMain -stage compute -o $out/scale.$target
        done
        grep -q 'numthreads(64, 1, 1)' $out/scale.hlsl
        grep -q 'local_size_x = 64' $out/scale.glsl
        grep -q '\\[\\[kernel\\]\\] void computeMain' $out/scale.metal
        grep -q '@workgroup_size(64, 1, 1)' $out/scale.wgsl
        grep -q '__global__ void computeMain' $out/scale.cuda
        grep -q 'computeMain' $out/scale.cpp
    """.format(val = SPIRV_VAL),
)

# GLSL source needs the GLSL module, and optimizing the result the glslang
# module; the compiler loads both from beside itself. Without the GLSL
# module it compiles the module from source instead, slowly but without
# complaint, so the test asks the dynamic loader what was used: glibc's
# says what it initializes, and dyld what it loads. Windows' loader has no
# such trace for a program to turn on, so the test is not run there.
LOADER_TRACES = {
    "config//os:linux": ("LD_DEBUG=libs", "calling init: .*"),
    "config//os:macos": ("DYLD_PRINT_LIBRARIES=1", "dyld.*"),
}

shims.command_test(
    name = "test-glsl",
    compatible_with = LOADER_TRACES.keys(),
    script = shims.select({
        os: """
        out=${{TMPDIR:-/tmp}}/slang-glsl-$$
        mkdir -p $out
        trap 'rm -rf $out' EXIT
        {trace} $(exe :slangc) $(location :double.comp) -stage compute -entry main -target spirv \\
            -o $out/double.spv 2>$out/ld.log
        grep -q "{loaded}/lib/{glsl_module}" $out/ld.log
        grep -q "{loaded}/lib/{glslang_module}" $out/ld.log
        {val} $out/double.spv
    """.format(
            glsl_module = names.glsl_module,
            glslang_module = names.glslang,
            loaded = LOADER_TRACES[os][1],
            trace = LOADER_TRACES[os][0],
            val = SPIRV_VAL,
        )
        for os, names in LIBRARIES.items()
        if os in LOADER_TRACES
    }),
)

shims.command_test(
    name = "test-reflection",
    script = """
        out=${TMPDIR:-/tmp}/slang-reflection-$$
        mkdir -p $out
        trap 'rm -rf $out' EXIT
        $(exe :slangc) $(location :scale.slang) -target spirv -o $out/scale.spv -reflection-json $out/scale.json
        grep -q '"name": "params"' $out/scale.json
        grep -q '"name": "data"' $out/scale.json
        grep -q '"threadGroupSize": \\[64, 1, 1\\]' $out/scale.json
    """,
)

shims.cxx_binary(
    name = "test-api-bin",
    srcs = [":api.cpp"],
    compiler_flags = SLANG_COMPILER_FLAGS,
    link_style = "shared",
    deps = [":slang"],
)

shims.command_test(
    name = "test-api",
    cmd = ["$(exe :test-api-bin)"],
)

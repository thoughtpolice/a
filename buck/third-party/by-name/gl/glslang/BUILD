# SPDX-FileCopyrightText: © 2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

load("@root//buck/shims:package.bzl", "pkg")
load("@root//buck/shims:shims.bzl", "shims")

# glslang, as its CMakeLists.txt files build it on Linux with SPIR-V output,
# the HLSL front end and the SPIRV-Tools optimizer (ENABLE_SPIRV,
# ENABLE_HLSL, ENABLE_OPT), and without RTTI or exceptions:
#
#   buck2 run third-party//by-name/gl/glslang:glslang-standalone -- -V shader.comp -o shader.spv
#
# C++ users link :glslang (the glslang and SPIRV libraries, which CMake
# builds as one) and :resource-limits for the default limits.

VERSION = pkg.version()

GIT_COMMIT = "d1f52c8993a501bd52d4fbd044bfeb9ecdceb9f4"

RUN_SCRIPT = "$(exe root//buck/tools/run-script:run-script)"

# glslang/CMakeLists.txt's GenericCodeGen, MachineIndependent (with HLSL)
# and CInterface sources, and SPIRV/CMakeLists.txt's; OSDEPENDENT_SOURCES
# follow below.
# glslang_tab.cpp is the Bison parser, which the tree carries generated.
GLSLANG_SOURCES = [
    "glslang/CInterface/glslang_c_interface.cpp",
    "glslang/GenericCodeGen/CodeGen.cpp",
    "glslang/GenericCodeGen/Link.cpp",
    "glslang/HLSL/hlslAttributes.cpp",
    "glslang/HLSL/hlslGrammar.cpp",
    "glslang/HLSL/hlslOpMap.cpp",
    "glslang/HLSL/hlslParseHelper.cpp",
    "glslang/HLSL/hlslParseables.cpp",
    "glslang/HLSL/hlslScanContext.cpp",
    "glslang/HLSL/hlslTokenStream.cpp",
    "glslang/MachineIndependent/Constant.cpp",
    "glslang/MachineIndependent/InfoSink.cpp",
    "glslang/MachineIndependent/Initialize.cpp",
    "glslang/MachineIndependent/IntermTraverse.cpp",
    "glslang/MachineIndependent/Intermediate.cpp",
    "glslang/MachineIndependent/ParseContextBase.cpp",
    "glslang/MachineIndependent/ParseHelper.cpp",
    "glslang/MachineIndependent/PoolAlloc.cpp",
    "glslang/MachineIndependent/RemoveTree.cpp",
    "glslang/MachineIndependent/Scan.cpp",
    "glslang/MachineIndependent/ShaderLang.cpp",
    "glslang/MachineIndependent/SpirvIntrinsics.cpp",
    "glslang/MachineIndependent/SymbolTable.cpp",
    "glslang/MachineIndependent/Versions.cpp",
    "glslang/MachineIndependent/attribute.cpp",
    "glslang/MachineIndependent/glslang_tab.cpp",
    "glslang/MachineIndependent/intermOut.cpp",
    "glslang/MachineIndependent/iomapper.cpp",
    "glslang/MachineIndependent/limits.cpp",
    "glslang/MachineIndependent/linkValidate.cpp",
    "glslang/MachineIndependent/parseConst.cpp",
    "glslang/MachineIndependent/preprocessor/Pp.cpp",
    "glslang/MachineIndependent/preprocessor/PpAtom.cpp",
    "glslang/MachineIndependent/preprocessor/PpContext.cpp",
    "glslang/MachineIndependent/preprocessor/PpScanner.cpp",
    "glslang/MachineIndependent/preprocessor/PpTokens.cpp",
    "glslang/MachineIndependent/propagateNoContraction.cpp",
    "glslang/MachineIndependent/reflection.cpp",
    "SPIRV/CInterface/spirv_c_interface.cpp",
    "SPIRV/GlslangToSpv.cpp",
    "SPIRV/InReadableOrder.cpp",
    "SPIRV/Logger.cpp",
    "SPIRV/SpvBuilder.cpp",
    "SPIRV/SpvPostProcess.cpp",
    "SPIRV/SpvTools.cpp",
    "SPIRV/disassemble.cpp",
    "SPIRV/doc.cpp",
]

# The OS layer (thread-local storage and the like) CMake picks for the host:
# OSDependent/Windows under WIN32, OSDependent/Unix elsewhere, each with the
# GLSLANG_OSINCLUDE_* definition that osinclude.h expects.
OS_SOURCES = {
    "config//os:linux": "glslang/OSDependent/Unix/ossource.cpp",
    "config//os:macos": "glslang/OSDependent/Unix/ossource.cpp",
    "config//os:windows": "glslang/OSDependent/Windows/ossource.cpp",
}

OS_DEFINES = {
    "config//os:linux": "-DGLSLANG_OSINCLUDE_UNIX",
    "config//os:macos": "-DGLSLANG_OSINCLUDE_UNIX",
    "config//os:windows": "-DGLSLANG_OSINCLUDE_WIN32",
}

RESOURCE_LIMITS_SOURCES = [
    "glslang/ResourceLimits/ResourceLimits.cpp",
    "glslang/ResourceLimits/resource_limits_c.cpp",
]

shims.http_archive(
    name = "src",
    excludes = [
        "^Test/",
        "^gtests/",
    ],
    sha256 = "d914157124abcec9e7d3bd8ba99f023d4cada87e67f38a3b76e4b70c15fd2c07",
    strip_prefix = "glslang-{}".format(GIT_COMMIT),
    sub_targets = sorted(GLSLANG_SOURCES + RESOURCE_LIMITS_SOURCES + [
        "glslang/OSDependent/Unix/ossource.cpp",
        "glslang/OSDependent/Windows/ossource.cpp",
        "StandAlone/StandAlone.cpp",
        "build_info.h.tmpl",
    ]),
    type = "tar.gz",
    urls = [
        "https://github.com/KhronosGroup/glslang/archive/{}.tar.gz".format(GIT_COMMIT),
    ],
)

# MARK: Generated headers

# The version, from CHANGES.md's latest entry, as CMake's configure_file()
# of build_info.h.tmpl would write it.
shims.genrule(
    name = "build_info.h",
    out = "build_info.h",
    cmd = "{} $(location :src)/build_info.py $(location :src) -i $(location :src[build_info.h.tmpl]) -o $OUT".format(RUN_SCRIPT),
)

# The GLSL extension headers the glslang tool can prepend to a shader
# (--glsl-version and friends), as C strings.
shims.genrule(
    name = "glsl_intrinsic_header.h",
    out = "glsl_intrinsic_header.h",
    cmd = "{} $(location :src)/gen_extension_headers.py -i $(location :src)/glslang/ExtensionHeaders -o $OUT".format(RUN_SCRIPT),
)

shims.cxx_library(
    name = "build-info",
    exported_headers = {
        "glslang/build_info.h": ":build_info.h",
    },
    header_namespace = "",
)

shims.cxx_library(
    name = "intrinsic-header",
    exported_headers = {
        "glslang/glsl_intrinsic_header.h": ":glsl_intrinsic_header.h",
    },
    header_namespace = "",
)

# MARK: Libraries

# The top-level CMakeLists.txt's add_compile_definitions() and its flags
# without ENABLE_RTTI and ENABLE_EXCEPTIONS: for MSVC, which clang-cl's
# flags follow, that is RTTI off and the C++ library's exceptions compiled
# out (where CMake also drops its default /EHsc). The public headers test
# ENABLE_HLSL and ENABLE_OPT too (for declarations only), so users see them.
COMPILER_FLAGS = shims.select({
    "config//os:windows": [
        "/GR-",
        "/D_HAS_EXCEPTIONS=0",
    ],
    "DEFAULT": [
        "-fno-rtti",
        "-fno-exceptions",
    ],
})

EXPORTED_PREPROCESSOR_FLAGS = [
    "-I$(location :src)",
    "-DENABLE_HLSL",
    "-DENABLE_OPT=1",
    "-DENABLE_SPIRV",
]

shims.cxx_library(
    name = "glslang",
    srcs = [":src[{}]".format(f) for f in GLSLANG_SOURCES] + shims.select({
        os: [":src[{}]".format(f)]
        for os, f in OS_SOURCES.items()
    }),
    compiler_flags = COMPILER_FLAGS,
    exported_deps = [
        "third-party//by-name/sp/spirv-tools:spirv-tools-opt",
        ":build-info",
    ],
    # Threads::Threads, which is the C library itself on Windows.
    exported_linker_flags = shims.select({
        "config//os:windows": [],
        "DEFAULT": ["-pthread"],
    }),
    exported_preprocessor_flags = EXPORTED_PREPROCESSOR_FLAGS,
    preferred_linkage = "static",
    preprocessor_flags = shims.select({
        os: [define]
        for os, define in OS_DEFINES.items()
    }),
    visibility = ["PUBLIC"],
)

shims.cxx_library(
    name = "resource-limits",
    srcs = [":src[{}]".format(f) for f in RESOURCE_LIMITS_SOURCES],
    compiler_flags = COMPILER_FLAGS,
    exported_deps = [":glslang"],
    preferred_linkage = "static",
    visibility = ["PUBLIC"],
)

# StandAlone/CMakeLists.txt's glslang-standalone, which installs as glslang
# (and glslangValidator, its old name).
shims.cxx_binary(
    name = "glslang-standalone",
    srcs = [":src[StandAlone/StandAlone.cpp]"],
    compiler_flags = COMPILER_FLAGS,
    link_style = "static",
    visibility = ["PUBLIC"],
    deps = [
        ":intrinsic-header",
        ":resource-limits",
    ],
)

# MARK: Tests

[
    shims.export_file(
        name = f,
        src = "tests/" + f,
    )
    for f in [
        "double.comp",
        "scale.hlsl",
    ]
]

shims.command_test(
    name = "test-version",
    script = """
        $(exe :glslang-standalone) --version | grep -q "^Glslang Version: 11:{}"
    """.format(VERSION.split("+")[0]),
)

# GLSL and HLSL compute shaders to SPIR-V, unoptimized and through
# SPIRV-Tools' optimizer (-Os), each checked by spirv-val; and a shader
# with an error, which must be rejected.
shims.command_test(
    name = "test-compile",
    script = """
        glslang=$(exe :glslang-standalone)
        val=$(exe third-party//by-name/sp/spirv-tools:spirv-val)
        dis=$(exe third-party//by-name/sp/spirv-tools:spirv-dis)
        out=${TMPDIR:-/tmp}/glslang-$$
        mkdir -p $out
        trap 'rm -rf $out' EXIT

        $glslang -V $(location :double.comp) -o $out/double.spv
        $val $out/double.spv
        $dis $out/double.spv | grep -q 'OpExecutionMode %main LocalSize 64 1 1'

        $glslang -V -Os $(location :double.comp) -o $out/double-os.spv
        $val $out/double-os.spv

        $glslang -V -D -e main -S comp $(location :scale.hlsl) -o $out/scale.spv
        $val $out/scale.spv
        $dis $out/scale.spv | grep -q 'OpEntryPoint GLCompute %main "main"'

        printf '#version 450\nvoid main() {{ undeclared = 1; }}\n' > $out/bad.comp
        if $glslang -V $out/bad.comp -o $out/bad.spv > $out/bad.log 2>&1; then
            echo "glslang accepted a shader with an error" >&2
            exit 1
        fi
        grep -q "undeclared" $out/bad.log
    """,
)

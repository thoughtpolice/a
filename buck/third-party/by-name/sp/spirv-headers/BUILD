# SPDX-FileCopyrightText: © 2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

load("@root//buck/shims:shims.bzl", "shims")

GIT_COMMIT = "86f980c731e62ae4eaf383d320449d71687936bf"

# include/spirv/unified1, the current headers; 1.0 to 1.2 are older copies.
HEADERS = [
    "AMD_gcn_shader.h",
    "AMD_shader_ballot.h",
    "AMD_shader_explicit_vertex_parameter.h",
    "AMD_shader_trinary_minmax.h",
    "ArmExperimentalMLOperations.h",
    "ArmMotionEngine.100.h",
    "DebugInfo.h",
    "GLSL.std.450.h",
    "NonSemanticClspvReflection.h",
    "NonSemanticDebugBreak.h",
    "NonSemanticDebugPrintf.h",
    "NonSemanticGraphDebugInfo.h",
    "NonSemanticShaderDebugInfo.h",
    "NonSemanticShaderDebugInfo100.h",
    "NonSemanticVkspReflection.h",
    "OpenCL.std.h",
    "OpenCLDebugInfo100.h",
    "TOSA.001000.1.h",
    "spirv.h",
    "spirv.hpp",
    "spirv.hpp11",
]

# SPIR-V 1.2's own GLSL.std.450.h, which SPIRV-Tools still includes.
HEADERS_1_2 = [
    "GLSL.std.450.h",
]

# The grammars other packages generate code from: the core grammar and every
# extended instruction set's.
GRAMMARS = [
    "extinst.arm.experimental-ml-operations.grammar.json",
    "extinst.arm.motion-engine.100.grammar.json",
    "extinst.debuginfo.grammar.json",
    "extinst.glsl.std.450.grammar.json",
    "extinst.nonsemantic.clspvreflection.grammar.json",
    "extinst.nonsemantic.debugbreak.grammar.json",
    "extinst.nonsemantic.debugprintf.grammar.json",
    "extinst.nonsemantic.graph.debuginfo.grammar.json",
    "extinst.nonsemantic.shader.debuginfo.100.grammar.json",
    "extinst.nonsemantic.shader.debuginfo.grammar.json",
    "extinst.nonsemantic.vkspreflection.grammar.json",
    "extinst.opencl.debuginfo.100.grammar.json",
    "extinst.opencl.std.100.grammar.json",
    "extinst.spv-amd-gcn-shader.grammar.json",
    "extinst.spv-amd-shader-ballot.grammar.json",
    "extinst.spv-amd-shader-explicit-vertex-parameter.grammar.json",
    "extinst.spv-amd-shader-trinary-minmax.grammar.json",
    "extinst.tosa.001000.1.grammar.json",
    "spirv.core.grammar.json",
]

shims.http_archive(
    name = "src",
    sha256 = "d11ef011d0788ed002d7cc96224d298f43b126cabe887cd4d46199cb19ecf386",
    strip_prefix = "SPIRV-Headers-{}".format(GIT_COMMIT),
    sub_targets = ["include/spirv/unified1/{}".format(f) for f in HEADERS + GRAMMARS] +
                  ["include/spirv/1.2/{}".format(f) for f in HEADERS_1_2] + [
        "include/spirv/spir-v.xml",
    ],
    type = "tar.gz",
    urls = [
        "https://github.com/KhronosGroup/SPIRV-Headers/archive/{}.tar.gz".format(GIT_COMMIT),
    ],
)

shims.cxx_library(
    name = "spirv-headers",
    exported_headers = {
        "spirv/unified1/{}".format(h): ":src[include/spirv/unified1/{}]".format(h)
        for h in HEADERS
    } | {
        "spirv/1.2/{}".format(h): ":src[include/spirv/1.2/{}]".format(h)
        for h in HEADERS_1_2
    },
    header_namespace = "",
)

[
    shims.alias(
        name = grammar,
        actual = ":src[include/spirv/unified1/{}]".format(grammar),
    )
    for grammar in GRAMMARS
]

# The registry of SPIR-V generator (tool) IDs.
shims.alias(
    name = "spir-v.xml",
    actual = ":src[include/spirv/spir-v.xml]",
)

shims.cxx_binary(
    name = "test-headers-bin",
    srcs = ["test.cpp"],
    deps = [":spirv-headers"],
)

shims.command_test(
    name = "test-headers",
    cmd = ["$(exe :test-headers-bin)"],
)

# The core grammar and the C header must describe the same SPIR-V.
shims.command_test(
    name = "test-grammar",
    script = """
        grammar=$(location :spirv.core.grammar.json)
        grep -q '"magic_number" : "0x07230203"' "$grammar"
        grep -q '"opname" : "OpCapability"' "$grammar"
        grep -q '"opname" : "Round"' $(location :extinst.glsl.std.450.grammar.json)
        grep -q 'tool="SPIR-V Tools Assembler"' $(location :spir-v.xml)
    """,
)

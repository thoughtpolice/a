# SPDX-FileCopyrightText: © 2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

load("@root//buck/shims:shims.bzl", "shims")
load("//aseipp/nogfx:defs.bzl", "NOGFX_COMPILER_FLAGS", "host_vulkan_program", "nogfx_shader")

# Upstream's deferred renderer example: objects simulated by a compute
# shader, drawn to a G-buffer by mesh shaders, and lit in a deferred pass,
# with the utility code it uses (upstream's utility/, here util/, as
# <util/...>).
#
#   buck2 run tilde//aseipp/nogfx/example
#
# (or tilde//aseipp/nogfx:main). Escape or closing the window quits.

# MARK: Utility

shims.cxx_library(
    name = "shader-types",
    exported_deps = ["//aseipp/nogfx"],
    exported_headers = ["util/shader_types.h"],
    header_namespace = "",
)

# Vectors and matrices, header-only, written for AVX2 and FMA, which its
# users must be compiled for. cxx_library has no exported compiler flags,
# but exported preprocessor flags reach the same compile commands.
shims.cxx_library(
    name = "math",
    exported_deps = [":shader-types"],
    exported_headers = ["util/math.hpp"],
    exported_preprocessor_flags = shims.select({
        "config//cpu:x86_64": [
            "-mavx2",
            "-mfma",
        ],
        "DEFAULT": [],
    }),
    header_namespace = "",
)

# Bump and heap allocators of GPU memory, and a queue deleting resources
# once the GPU is done with them.
shims.cxx_library(
    name = "allocators",
    srcs = [
        "util/bump_allocator.cpp",
        "util/delete_queue.cpp",
        "util/heap_allocator.cpp",
    ],
    compiler_flags = NOGFX_COMPILER_FLAGS,
    exported_deps = ["//aseipp/nogfx"],
    exported_headers = [
        "util/bump_allocator.hpp",
        "util/delete_queue.hpp",
        "util/fixed_function.hpp",
        "util/heap_allocator.hpp",
    ],
    header_namespace = "",
    preferred_linkage = "static",
)

# Placement of textures in texture heaps.
shims.cxx_library(
    name = "textures",
    srcs = ["util/texture_allocator.cpp"],
    compiler_flags = NOGFX_COMPILER_FLAGS,
    exported_deps = [":allocators"],
    exported_headers = ["util/texture_allocator.hpp"],
    header_namespace = "",
    preferred_linkage = "static",
)

# Reading shaders and other files whole (upstream's example_support.cpp).
shims.cxx_library(
    name = "file",
    srcs = ["util/file.cpp"],
    compiler_flags = NOGFX_COMPILER_FLAGS,
    exported_deps = ["//aseipp/nogfx"],
    exported_headers = ["util/file.hpp"],
    header_namespace = "",
    preferred_linkage = "static",
)

# MARK: Renderer

SHARED_HEADERS = [
    "deferred_lighting_shared.h",
    "gbuffer_shared.h",
    "object_data.h",
    "simulation_shared.h",
    "util/shader_types.h",
]

# output: (source, entry point, stage), from upstream's CMakeLists.txt.
SHADERS = {
    "deferred.frag.spv": ("deferred_lighting.slang", "fragmentMain", "fragment"),
    "deferred.vert.spv": ("deferred_lighting.slang", "vertexMain", "vertex"),
    "gbuffer.frag.spv": ("gbuffer.slang", "fragmentMain", "fragment"),
    "gbuffer.mesh.spv": ("gbuffer.slang", "meshMain", "mesh"),
    "simulation.comp.spv": ("simulation.slang", "computeMain", "compute"),
}

[
    nogfx_shader(
        name = output,
        src = src,
        srcs = SHARED_HEADERS,
        entry = entry,
        stage = stage,
    )
    for output, (src, entry, stage) in SHADERS.items()
]

# The renderer finds its shaders at paths CMake bakes in; here they are
# relative to its install tree, which :example runs it from.
shims.cxx_binary(
    name = "renderer",
    srcs = ["main.cpp"],
    compiler_flags = NOGFX_COMPILER_FLAGS,
    headers = SHARED_HEADERS,
    link_style = "shared",
    preprocessor_flags = [
        "-DNOGRAPHICSAPI_SIMULATION_COMPUTE_SHADER_PATH=\"shaders/simulation.comp.spv\"",
        "-DNOGRAPHICSAPI_GBUFFER_MESH_SHADER_PATH=\"shaders/gbuffer.mesh.spv\"",
        "-DNOGRAPHICSAPI_GBUFFER_FRAGMENT_SHADER_PATH=\"shaders/gbuffer.frag.spv\"",
        "-DNOGRAPHICSAPI_DEFERRED_VERTEX_SHADER_PATH=\"shaders/deferred.vert.spv\"",
        "-DNOGRAPHICSAPI_DEFERRED_FRAGMENT_SHADER_PATH=\"shaders/deferred.frag.spv\"",
    ],
    deps = [
        ":file",
        ":math",
        ":textures",
        "//aseipp/nogfx/window",
    ],
)

host_vulkan_program(
    name = "example",
    binary = ":renderer",
    data = {
        "shaders/" + shader: ":" + shader
        for shader in SHADERS.keys()
    },
)

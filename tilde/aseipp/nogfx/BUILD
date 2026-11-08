# SPDX-FileCopyrightText: © 2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

load("@root//buck/shims:shims.bzl", "shims")
load(":defs.bzl", "NOGFX_COMPILER_FLAGS")

# nogfx: NoGraphicsAPI's Vulkan backend (lib/), as <nogfx/nogfx.hpp>
# (include/nogfx; namespace gpu). window/ has a window to present to, and
# example/ upstream's deferred renderer, which :main runs:
#
#   buck2 run tilde//aseipp/nogfx:main

shims.cxx_library(
    name = "nogfx",
    srcs = ["lib/vulkan.cpp"],
    compiler_flags = NOGFX_COMPILER_FLAGS,
    exported_deps = ["third-party//by-name/vu/vulkan-headers:vulkan-headers"],
    exported_headers = {
        "nogfx/" + h.removeprefix("include/nogfx/"): h
        for h in glob([
            "include/nogfx/*.h",
            "include/nogfx/*.hpp",
        ])
    },
    header_namespace = "",
    headers = {
        "buffer_address_map.hpp": "lib/buffer_address_map.hpp",
    },
    preferred_linkage = "static",
    deps = [
        # depot: for the Xlib WSI's <X11/Xlib.h>; see lib/vulkan.cpp.
        "third-party//by-name/vu/vulkan-loader:wsi-types",
        "third-party//by-name/vu/vulkan-loader:vulkan",
    ],
)

# The shader library shaders include as <nogfx/shader.slang>, laid out so,
# for nogfx_shader() (defs.bzl).
shims.copy_files(
    name = "shader-include",
    srcs = {
        "nogfx/shader.slang": "include/nogfx/shader.slang",
    },
)

shims.alias(
    name = "main",
    actual = "//aseipp/nogfx/example:example",
)

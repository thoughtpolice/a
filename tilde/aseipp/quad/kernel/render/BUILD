# SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

# Drawing the GUI's frames: Vulkan on Linux, Metal 4 on macOS, in a window
# or into an image.

load("@root//buck/shims:shims.bzl", "shims")
load("//aseipp/quad:defs.bzl", "slang_metal", "slang_shader")

DEPS = [
    "//aseipp/quad/kernel/font:font",
    "//aseipp/quad/kernel/image:image",
    "//aseipp/quad/kernel/timing:timing",
    "third-party//rust:winit",
] + shims.select({
    "config//os:linux": ["third-party//rust:ash"],
    "config//os:macos": [
        "third-party//rust:objc2",
        "third-party//rust:objc2-app-kit",
        "third-party//rust:objc2-core-foundation",
        "third-party//rust:objc2-core-graphics",
        "third-party//rust:objc2-foundation",
        "third-party//rust:objc2-metal",
        "third-party//rust:objc2-quartz-core",
    ],
})

# The GUI's shaders (gui.slang), beside lib.rs, which includes them: for
# Vulkan, SPIR-V of a vertex and a fragment shader for each of its
# pipelines; for Metal, the source of all of them, which Metal compiles as
# the device is made.
GUI_SHADERS = {
    "gui.glyph.frag.spv": ("glyphFragment", "fragment"),
    "gui.glyph.vert.spv": ("glyphVertex", "vertex"),
    "gui.image.frag.spv": ("imageFragment", "fragment"),
    "gui.image.vert.spv": ("imageVertex", "vertex"),
    "gui.rect.frag.spv": ("rectFragment", "fragment"),
    "gui.rect.vert.spv": ("rectVertex", "vertex"),
}

[
    slang_shader(
        name = out,
        src = "gui.slang",
        entry = entry,
        stage = stage,
    )
    for out, (entry, stage) in GUI_SHADERS.items()
]

slang_metal(
    name = "gui.metal",
    src = "gui.slang",
    entries = sorted(GUI_SHADERS.values()),
)

SHADERS = shims.select({
    "config//os:linux": {":" + out: out for out in GUI_SHADERS},
    "config//os:macos": {":gui.metal": "gui.metal"},
})

shims.rust_library(
    name = "render",
    srcs = glob(["*.rs"]),
    crate = "quad_render",
    crate_root = "lib.rs",
    mapped_srcs = SHADERS,
    tests = [":render-test"],
    visibility = ["//aseipp/quad/..."],
    deps = DEPS,
)

shims.rust_test(
    name = "render-test",
    srcs = glob(["*.rs"]),
    crate = "quad_render",
    crate_root = "lib.rs",
    mapped_srcs = SHADERS,
    deps = DEPS + ["third-party//rust:hegeltest"],
)

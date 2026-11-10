# SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

# Fonts (fontique), shaping (harfrust), outlines as Slug draws them, and
# color emoji. JetBrains Mono is built in, beside lib.rs.

load("@root//buck/shims:shims.bzl", "shims")

DEPS = [
    "//aseipp/quad/kernel/image:image",
    "//aseipp/quad/kernel/timing:timing",
    "third-party//rust:fontique",
    "third-party//rust:harfrust",
    "third-party//rust:skrifa",
]

# The window's default font, beside lib.rs, which includes it.
BUILT_IN_FONTS = {
    "third-party//by-name/je/jetbrains-mono:" + style: "fonts/JetBrainsMono-{}.ttf".format(style)
    for style in [
        "Regular",
        "Bold",
        "Italic",
        "BoldItalic",
    ]
}

shims.rust_library(
    name = "font",
    srcs = glob(["*.rs"]),
    crate = "quad_font",
    crate_root = "lib.rs",
    mapped_srcs = BUILT_IN_FONTS,
    tests = [":font-test"],
    visibility = ["//aseipp/quad/..."],
    deps = DEPS,
)

shims.rust_test(
    name = "font-test",
    srcs = glob(["*.rs"]),
    crate = "quad_font",
    crate_root = "lib.rs",
    mapped_srcs = BUILT_IN_FONTS,
    deps = DEPS + ["third-party//rust:hegeltest"],
)

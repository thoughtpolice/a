# SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

# The GUI's windows (winit), their screens, screen readers (AccessKit), and
# the main thread they run on.

load("@root//buck/shims:shims.bzl", "shims")

DEPS = [
    "//aseipp/quad/kernel/chez-rs:chez",
    "//aseipp/quad/kernel/font:font",
    "//aseipp/quad/kernel/fx:fx",
    "//aseipp/quad/kernel/image:image",
    "//aseipp/quad/kernel/render:render",
    "//aseipp/quad/kernel/timing:timing",
    "third-party//rust:accesskit",
    "third-party//rust:accesskit_winit",
    "third-party//rust:unicode-width",
    "third-party//rust:winit",
] + shims.select({
    "config//os:linux": [
        "third-party//rust:ash",
        "third-party//rust:smithay-clipboard",
    ],
    "config//os:macos": [
        "third-party//rust:objc2",
        "third-party//rust:objc2-app-kit",
        "third-party//rust:objc2-core-foundation",
        "third-party//rust:objc2-core-graphics",
        "third-party//rust:objc2-foundation",
    ],
})

shims.rust_library(
    name = "gui",
    srcs = glob(["*.rs"]),
    crate = "quad_gui",
    crate_root = "lib.rs",
    tests = [":gui-test"],
    visibility = ["//aseipp/quad/..."],
    deps = DEPS,
)

shims.rust_test(
    name = "gui-test",
    srcs = glob(["*.rs"]),
    crate = "quad_gui",
    crate_root = "lib.rs",
    deps = DEPS + ["third-party//rust:hegeltest"],
)

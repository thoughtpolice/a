# SPDX-FileCopyrightText: © 2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

# Animation: easings, timing, effects, and drawing them on the CPU
# (docs/animation.md).

load("@root//buck/shims:shims.bzl", "shims")

shims.rust_library(
    name = "fx",
    srcs = glob(["*.rs"]),
    crate = "quad_fx",
    crate_root = "lib.rs",
    tests = [":fx-test"],
    visibility = ["//aseipp/quad/..."],
)

shims.rust_test(
    name = "fx-test",
    srcs = glob(["*.rs"]),
    crate = "quad_fx",
    crate_root = "lib.rs",
    deps = ["third-party//rust:hegeltest"],
)

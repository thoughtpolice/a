# SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

# How long starting up takes (QUAD_TIMING=1): the kernel's steps, timed.

load("@root//buck/shims:shims.bzl", "shims")

DEPS = ["third-party//rust:libc"]

shims.rust_library(
    name = "timing",
    srcs = glob(["*.rs"]),
    crate = "quad_timing",
    crate_root = "lib.rs",
    visibility = ["//aseipp/quad/..."],
    deps = DEPS,
)

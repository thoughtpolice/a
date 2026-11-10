# SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

# Images: PNGs decoded, scaled, placed over cells.

load("@root//buck/shims:shims.bzl", "shims")

DEPS = [
    "third-party//rust:png",
]

shims.rust_library(
    name = "image",
    srcs = glob(["*.rs"]),
    crate = "quad_image",
    crate_root = "lib.rs",
    tests = [":image-test"],
    visibility = ["//aseipp/quad/..."],
    deps = DEPS,
)

shims.rust_test(
    name = "image-test",
    srcs = glob(["*.rs"]),
    crate = "quad_image",
    crate_root = "lib.rs",
    deps = DEPS + ["third-party//rust:hegeltest"],
)

# SPDX-FileCopyrightText: © 2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

# Line diffs: which lines of a buffer differ from a version of its file.

load("@root//buck/shims:shims.bzl", "shims")

shims.rust_library(
    name = "diff",
    srcs = glob(["*.rs"]),
    crate = "quad_diff",
    crate_root = "lib.rs",
    tests = [":diff-test"],
    visibility = ["//aseipp/quad/..."],
)

shims.rust_test(
    name = "diff-test",
    srcs = glob(["*.rs"]),
    crate = "quad_diff",
    crate_root = "lib.rs",
    deps = ["third-party//rust:hegeltest"],
)

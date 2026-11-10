# SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

# Buffer text, a rope (ropey), and searching it (regex-cursor).

load("@root//buck/shims:shims.bzl", "shims")

DEPS = [
    "//aseipp/quad/kernel/diff:diff",
    "third-party//rust:regex-cursor",
    "third-party//rust:ropey",
]

shims.rust_library(
    name = "text",
    srcs = glob(["*.rs"]),
    crate = "quad_text",
    crate_root = "lib.rs",
    tests = [":text-test"],
    visibility = ["//aseipp/quad/..."],
    deps = DEPS,
)

shims.rust_test(
    name = "text-test",
    srcs = glob(["*.rs"]),
    crate = "quad_text",
    crate_root = "lib.rs",
    deps = DEPS + ["third-party//rust:hegeltest"],
)

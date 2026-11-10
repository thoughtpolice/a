# SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

# A project's files, as its ignore files say, and searching them (grep).

load("@root//buck/shims:shims.bzl", "shims")

DEPS = [
    "//aseipp/quad/kernel/chez-rs:chez",
    "third-party//rust:ignore",
    "third-party//rust:regex",
]

shims.rust_library(
    name = "files",
    srcs = glob(["*.rs"]),
    crate = "quad_files",
    crate_root = "lib.rs",
    tests = [":files-test"],
    visibility = ["//aseipp/quad/..."],
    deps = DEPS,
)

shims.rust_test(
    name = "files-test",
    srcs = glob(["*.rs"]),
    crate = "quad_files",
    crate_root = "lib.rs",
    deps = DEPS + ["third-party//rust:hegeltest"],
)

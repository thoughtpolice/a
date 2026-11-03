# SPDX-FileCopyrightText: © 2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

load("@root//buck/shims:shims.bzl", depot = "shims")

depot.rust_library(
    name = "mesh",
    srcs = glob(["*.rs"]),
    crate_root = "lib.rs",
    visibility = ["//src/gonzo/..."],
    deps = ["//src/crates/iroh-mesh"],
)

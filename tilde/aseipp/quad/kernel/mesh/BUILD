# SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

# Editors and their clients over iroh (iroh-mesh).

load("@root//buck/shims:shims.bzl", "shims")

DEPS = [
    "//aseipp/quad/kernel/chez-rs:chez",
    "root//src/crates/accept:accept",
    "root//src/crates/iroh-dial:iroh-dial",
    "root//src/crates/iroh-mesh:iroh-mesh",
    "third-party//rust:futures",
    "third-party//rust:iroh",
    "third-party//rust:libc",
    "third-party//rust:tokio",
]

shims.rust_library(
    name = "mesh",
    srcs = glob(["*.rs"]),
    crate = "quad_mesh",
    crate_root = "lib.rs",
    visibility = ["//aseipp/quad/..."],
    deps = DEPS,
)

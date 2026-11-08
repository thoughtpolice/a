# SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

# Rust for Chez Scheme: Rust procedures and objects callable from Scheme,
# with types checked at the boundary (lib.rs). :scheme is the Scheme half,
# (chez rust), which the libraries chez.rust_library generates import.

load("@root//buck/shims:shims.bzl", depot = "shims")
load("@toolchains//chez:defs.bzl", "chez")

CHEZ = "third-party//by-name/ch/chez-scheme"

# scheme.h's macros as functions, compiled against the Chez Scheme linked.
depot.cxx_library(
    name = "shim",
    srcs = ["shim.c"],
    compiler_flags = [
        "-std=gnu11",
        "-Wall",
        "-Wextra",
        "-O2",
    ],
    preferred_linkage = "static",
    deps = ["toolchains//chez:kernel"],
)

DEPS = [
    ":shim",
    "//aseipp/quad/chez-rs/macros:chez-macros",
    "third-party//rust:libc",
]

depot.rust_library(
    name = "chez",
    srcs = glob(["*.rs"]),
    crate_root = "lib.rs",
    tests = [":tests"],
    visibility = ["PUBLIC"],
    deps = DEPS,
)

chez.library(
    name = "scheme",
    srcs = {"chez/rust.sls": "rust.sls"},
    visibility = ["PUBLIC"],
)

# Boots Chez Scheme in the test process, and calls Rust procedures from
# Scheme through the library the crate generates.
depot.rust_test(
    name = "tests",
    srcs = glob([
        "*.rs",
        "tests/*.rs",
    ]),
    crate = "chez",
    crate_root = "lib.rs",
    env = {
        "CHEZ_PETITE_BOOT": "$(location {}:install[petite.boot])".format(CHEZ),
        "CHEZ_RUST_SLS": "$(location :rust.sls)",
        "CHEZ_SCHEME_BOOT": "$(location {}:install[scheme.boot])".format(CHEZ),
    },
    deps = DEPS,
)

depot.export_file(
    name = "rust.sls",
    src = "rust.sls",
)

# SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

load("@root//buck/shims:shims.bzl", depot = "shims")

depot.cxx_library(
    name = "wbob-pi",
    srcs = glob(["*.c"]),
    exported_headers = ["wbob-pi.h"],
    raw_headers = ["wbob-pi.h"],
)

depot.cxx_genrule(
    name = "wbob-pi-rs",
    srcs = ["wbob-pi.h"],
    outs = {
        "bindings-rs": ["wbob-pi.rs"],
    },
    cmd = "bindgen wbob-pi.h -o $OUT/wbob-pi.rs",
)

depot.rust_library(
    name = "stribob",
    srcs = ["stribob.rs"],
    env = {
        "WBOB_BINDGEN_H": "$(location :wbob-pi-rs)",
    },
    deps = [
        ":wbob-pi",
    ],
)

depot.rust_binary(
    name = "main",
    srcs = ["main.rs"],
    deps = [
        "third-party//by-name/mi/mimalloc:rust",
        ":stribob",
    ],
)

# SPDX-FileCopyrightText: © 2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

load("@root//buck/shims:shims.bzl", depot = "shims")

LIB_SRCS = glob(
    ["*.rs"],
    exclude = ["clone.rs"],
)

DEPS = [
    "//src/crates/egress:egress",
    "//src/crates/egress-http:egress-http",
    "third-party//rust:bytes",
    "third-party//rust:dial9",
    "third-party//rust:flate2",
    "third-party//rust:gix-features",
    "third-party//rust:gix-hash",
    "third-party//rust:gix-object",
    "third-party//rust:gix-pack",
    "third-party//rust:gix-zlib",
    "third-party//rust:hex",
    "third-party//rust:http-body-util",
    "third-party//rust:hyper",
    "third-party//rust:memmap2",
    "third-party//rust:openssl",
    "third-party//rust:sha1",
    "third-party//rust:tempfile",
    "third-party//rust:tokio",
    "third-party//rust:tokio-util",
    "third-party//rust:tracing",
]

depot.rust_library(
    name = "fetch-git",
    srcs = LIB_SRCS,
    visibility = ["//src/tools/cache-server/..."],
    deps = DEPS,
)

depot.rust_test(
    name = "tests",
    srcs = LIB_SRCS,
    deps = DEPS + ["third-party//rust:hyper-util"],
)

depot.rust_binary(
    name = "clone",
    srcs = ["clone.rs"],
    crate_root = "clone.rs",
    visibility = ["//src/tools/cache-server/..."],
    deps = [
        "third-party//by-name/mi/mimalloc:rust",
        "third-party//rust:clap",
        "third-party//rust:dial9",
        "third-party//rust:hex",
        "third-party//rust:tokio",
        "third-party//rust:tracing",
        "third-party//rust:tracing-subscriber",
        ":fetch-git",
    ],
)

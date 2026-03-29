# SPDX-FileCopyrightText: © 2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

load("@root//buck/shims:shims.bzl", depot = "shims")

LIB_SRCS = glob(
    ["*.rs"],
    exclude = [
        "clone.rs",
        "packstat.rs",
    ],
)

DEPS = [
    "third-party//rust:bytes",
    "third-party//rust:dial9",
    "third-party//rust:flate2",
    "third-party//rust:hex",
    "third-party//rust:http",
    "third-party//rust:http-body-util",
    "third-party//rust:hyper",
    "third-party//rust:hyper-util",
    "third-party//rust:memmap2",
    "third-party//rust:openssl",
    "third-party//rust:rayon",
    "third-party//rust:tempfile",
    "third-party//rust:sha1",
    "third-party//rust:sha2",
    "third-party//rust:tokio",
    "third-party//rust:tokio-openssl",
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
    deps = DEPS,
)

depot.rust_binary(
    name = "clone",
    srcs = ["clone.rs"],
    crate_root = "clone.rs",
    visibility = ["//src/tools/cache-server/..."],
    deps = [
        "third-party//rust:clap",
        "third-party//rust:dial9",
        "third-party//rust:hex",
        "third-party//rust:tokio",
        "third-party//rust:tracing",
        "third-party//rust:tracing-subscriber",
        ":fetch-git",
    ],
)

depot.rust_binary(
    name = "packstat",
    srcs = ["packstat.rs"],
    crate_root = "packstat.rs",
    visibility = ["//src/tools/cache-server/..."],
    deps = [
        "third-party//rust:clap",
        "third-party//rust:tokio",
        ":fetch-git",
    ],
)

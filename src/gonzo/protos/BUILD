# SPDX-FileCopyrightText: © 2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

load("@root//buck/shims:shims.bzl", depot = "shims")
load("@toolchains//protoc:defs.bzl", "protoc_env")

depot.rust_library(
    name = "gonzo-protos",
    srcs = ["lib.rs"],
    crate_root = "lib.rs",
    env = {
        "PROTOBUFS": "$(location :protos.rs)",
    },
    visibility = ["//src/gonzo/..."],
    deps = [
        "third-party//rust:prost",
        "third-party//rust:prost-types",
        "third-party//rust:tonic",
        "third-party//rust:tonic-prost",
        "//src/crates/reapi-protos:protos",
    ],
)

depot.rust_binary(
    name = "gen-protos",
    srcs = ["generate.rs"],
    crate_root = "generate.rs",
    visibility = [],
    deps = [
        "third-party//rust:tonic-prost-build",
    ],
)

depot.genrule(
    name = "protos.rs",
    srcs = glob(["**/*.proto"]),
    out = ".",
    cmd = "$(exe :gen-protos)",
    env = protoc_env() | {
        # The REAPI protos the worker protocol imports.
        "REAPI_PROTOS": "$(location //src/crates/reapi-protos:proto-srcs)",
    },
    visibility = [],
)

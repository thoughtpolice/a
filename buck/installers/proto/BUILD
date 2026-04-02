# SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

load("@root//buck/shims:shims.bzl", depot = "shims")
load("@toolchains//protoc:defs.bzl", "protoc_env")

depot.http_file(
    name = 'install.proto',
    sha256 = '32e879b486432853de4b5bf65a9e36138c0c8c8b787010ff0b1daa6f6c44d78b',
    urls = [
        'https://raw.githubusercontent.com/facebook/buck2/b3f8aa4001/app/buck2_install_proto/install.proto',
    ],
)

depot.rust_library(
    name = 'proto',
    srcs = ['lib.rs'],
    deps = [
        'third-party//rust:prost',
        'third-party//rust:prost-types',
        'third-party//rust:tonic',
        'third-party//rust:tonic-prost',
    ],
    env = {
        'PROTOBUFS': '$(location :protos.rs)',
    },
    visibility = ['PUBLIC'],
)

depot.rust_binary(
    name = 'gen-protos',
    srcs = ['generate.rs'],
    crate_root = 'generate.rs',
    deps = [
        'third-party//rust:tonic-prost-build',
        'third-party//rust:tonic-prost',
    ],
    visibility = [],
)

depot.genrule(
    name = 'protos.rs',
    cmd = '$(exe :gen-protos)',
    out = '.',
    srcs = [':install.proto'],
    env = protoc_env(),
    visibility = [],
)

# SPDX-FileCopyrightText: © 2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

load("@root//buck/shims:shims.bzl", depot = "shims")

# Firefox's CRLite revocation filters: the `crlite` library, for TLS clients
# to check certificates against.

DEPS = [
    "third-party//rust:base64",
    "third-party//rust:bincode",
    "third-party//rust:clubcard-crlite",
    "third-party//rust:hex",
    "third-party//rust:log",
    "third-party//rust:openssl",
    "third-party//rust:reqwest",
    "third-party//rust:serde",
    "third-party//rust:x509-parser",
]

LIB_SRCS = [
    "lib.rs",
    "update.rs",
]

depot.rust_library(
    name = "crlite",
    srcs = LIB_SRCS,
    crate_root = "lib.rs",
    visibility = ["PUBLIC"],
    deps = DEPS,
)

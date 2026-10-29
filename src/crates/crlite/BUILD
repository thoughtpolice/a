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

# The fixture builds filters and certificates for the tests.
TEST_DEPS = [
    ":fixture",
    "third-party//rust:tempfile",
]

LIB_SRCS = [
    "lib.rs",
    "update.rs",
]

depot.rust_library(
    name = "crlite",
    srcs = LIB_SRCS,
    crate_root = "lib.rs",
    # rust-analyzer merges a test target named `<library>-unittest` into the
    # library crate.
    tests = [":crlite-unittest"],
    visibility = ["PUBLIC"],
    deps = DEPS,
)

# Certificates and a filter for tests, here and in the crates that check
# chains against CRLite.
depot.rust_library(
    name = "fixture",
    srcs = ["fixture.rs"],
    crate = "crlite_fixture",
    crate_root = "fixture.rs",
    visibility = [
        "root//src/crates/egress-http/...",
        "root//src/crates/revocation/...",
        "root//src/crates/rustls-transport/...",
    ],
    deps = [
        "third-party//rust:base64",
        "third-party//rust:clubcard",
        "third-party//rust:clubcard-crlite",
        "third-party//rust:openssl",
        "third-party//rust:x509-parser",
    ],
)

depot.rust_test(
    name = "crlite-unittest",
    srcs = LIB_SRCS + ["tests.rs"],
    crate_root = "lib.rs",
    deps = DEPS + TEST_DEPS,
)

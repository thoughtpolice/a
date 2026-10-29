# SPDX-FileCopyrightText: © 2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

load("@root//buck/shims:shims.bzl", depot = "shims")

# OneCRL, Firefox's list of revoked certificates (chiefly intermediates).

DEPS = [
    "third-party//rust:base64",
    "third-party//rust:log",
    "third-party//rust:openssl",
    "third-party//rust:reqwest",
    "third-party//rust:serde",
    "third-party//rust:serde_json",
    "third-party//rust:x509-parser",
]

depot.rust_library(
    name = "onecrl",
    srcs = ["lib.rs"],
    crate_root = "lib.rs",
    # rust-analyzer merges a test target named `<library>-unittest` into the
    # library crate.
    tests = [":onecrl-unittest"],
    visibility = ["PUBLIC"],
    deps = DEPS,
)

# The certificate chains of the eMudhra intermediate CA compromise of October
# 2026, from https://emudhra.we-have-a-problem.com/ (chains.zip; the site is
# Apache-2.0), and the OneCRL records that revoke those intermediates, taken
# from the collection on 29 October 2026.
depot.filegroup(
    name = "testdata",
    srcs = glob(["testdata/**"]),
    visibility = ["//src/crates/crlite/..."],
)

depot.rust_test(
    name = "onecrl-unittest",
    srcs = [
        "lib.rs",
        "tests.rs",
    ],
    crate_root = "lib.rs",
    run_env = {
        "ONECRL_TESTDATA": "$(location :testdata)",
    },
    deps = DEPS,
)

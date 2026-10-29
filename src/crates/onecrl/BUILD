# SPDX-FileCopyrightText: © 2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

load("@root//buck/shims:shims.bzl", depot = "shims")

# OneCRL, Firefox's list of revoked certificates (chiefly intermediates).

DEPS = [
    "third-party//rust:base64",
    "third-party//rust:openssl",
    "third-party//rust:serde",
    "third-party//rust:serde_json",
    "third-party//rust:x509-parser",
]

depot.rust_library(
    name = "onecrl",
    srcs = ["lib.rs"],
    crate_root = "lib.rs",
    visibility = ["PUBLIC"],
    deps = DEPS,
)

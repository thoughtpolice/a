# SPDX-FileCopyrightText: © 2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

load("@root//buck/shims:shims.bzl", depot = "shims")

# Firefox's CRLite revocation filters: the `crlite` library, for TLS clients
# to check certificates against.

depot.rust_library(
    name = "crlite",
    srcs = ["lib.rs"],
    crate_root = "lib.rs",
    visibility = ["PUBLIC"],
)

# SPDX-FileCopyrightText: © 2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

load("@root//buck/shims:shims.bzl", depot = "shims")

# OneCRL, Firefox's list of revoked certificates (chiefly intermediates).

depot.rust_library(
    name = "onecrl",
    srcs = ["lib.rs"],
    crate_root = "lib.rs",
    visibility = ["PUBLIC"],
)

# SPDX-FileCopyrightText: © 2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

load("@root//buck/shims:shims.bzl", "shims")

# jj-cli is built as a library (third-party//rust); this is its command,
# as upstream's cli/src/main.rs makes it.
shims.rust_binary(
    name = "jj",
    srcs = ["main.rs"],
    crate = "jj",
    crate_root = "main.rs",
    deps = [
        "third-party//by-name/mi/mimalloc:rust",
        "third-party//rust:jj-cli",
    ],
)

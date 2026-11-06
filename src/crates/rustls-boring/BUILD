# SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

load("@root//buck/shims:shims.bzl", depot = "shims")

depot.rust_library(
    name = "rustls-boring",
    srcs = glob(["*.rs"]),
    crate_root = "lib.rs",
    # The `-unittest` companion below shares lib.rs, so rust-project
    # (buck/toolchains/rust/lsp) folds it into the library's crate (one
    # crate with cfg(test)) instead of giving rust-analyzer a second crate
    # on lib.rs.
    tests = [":rustls-boring-unittest"],
    visibility = ["PUBLIC"],
    deps = [
        "third-party//by-name/bo/boringssl/rust:bssl-sys",
        "third-party//rust:openssl",
        "third-party//rust:rustls",
        "third-party//rust:zeroize",
    ],
)

depot.rust_test(
    name = "rustls-boring-unittest",
    srcs = glob(["*.rs"]),
    crate_root = "lib.rs",
    deps = [
        "third-party//by-name/bo/boringssl/rust:bssl-sys",
        "third-party//rust:openssl",
        "third-party//rust:rustls",
        "third-party//rust:zeroize",
    ],
)

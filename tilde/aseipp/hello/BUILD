# SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

load("@root//buck/shims:shims.bzl", depot = "shims")

depot.rust_binary(
    name = "hello",
    srcs = glob(["*.rs"]),
    deps = [
        "third-party//by-name/mi/mimalloc:rust",
    ],
)

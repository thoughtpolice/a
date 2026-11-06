# SPDX-FileCopyrightText: © 2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

load("@root//buck/shims:shims.bzl", "shims")

# A binary using a library under another name, a proc macro, and a
# third-party crate through its alias, for the language server's smoke test.
shims.rust_binary(
    name = "hello",
    srcs = ["main.rs"],
    named_deps = {"salutation": "//rust/lsp/tests/greeting:greeting"},
    deps = [
        "third-party//by-name/mi/mimalloc:rust",
        "third-party//rust:anyhow",
        "//rust/lsp/tests/answer",
    ],
)

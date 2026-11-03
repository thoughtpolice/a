# SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

load("@root//buck/shims:shims.bzl", depot = "shims")

# The devcontainer's layer builders. Like minimos's tools they are
# stdlib-only Python on the repository's interpreter.

depot.python_binary(
    name = "apk_layer",
    base_module = "",
    main = "apk_layer.py",
    visibility = ["PUBLIC"],
)

depot.python_binary(
    name = "rust_layer",
    base_module = "",
    main = "rust_layer.py",
    visibility = ["PUBLIC"],
)

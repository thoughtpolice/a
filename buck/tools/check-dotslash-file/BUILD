# SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

load("@root//buck/shims:shims.bzl", "shims")

# Test harnesses for dotslash file verification
# The actual tests are defined in //buck/bin:dotslash-check

shims.python_binary(
    name = "check-hashes",
    main = "hashes.py",
    visibility = ["PUBLIC"],
)

shims.python_binary(
    name = "check-windows-shim",
    main = "windows-shim.py",
    visibility = ["PUBLIC"],
)

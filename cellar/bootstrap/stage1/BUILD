# SPDX-FileCopyrightText: 2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

load("@cellar//bootstrap/stage1/installation:defs.bzl", "alias")

# The native installation, which stage1/installation assembles, under the
# labels that the documentation uses.
[
    alias(
        name = name,
        actual = "cellar//bootstrap/stage1/installation:" + name,
    )
    for name in [
        "all",
        "toolchain",
        "userland",
    ]
]

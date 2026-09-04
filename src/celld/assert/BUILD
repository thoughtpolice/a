# SPDX-FileCopyrightText: © 2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

load("@toolchains//celld:defs.bzl", "celld")

celld.library(
    name = "assert",
    import_name = "@celld/assert",
    visibility = ["PUBLIC"],
)

celld.test(
    name = "test",
    srcs = ["mod_test.ts"],
    deps = [":assert"],
)

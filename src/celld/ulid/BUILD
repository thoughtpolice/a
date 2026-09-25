# SPDX-FileCopyrightText: © 2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

load("@toolchains//celld:defs.bzl", "celld")

celld.library(
    name = "ulid",
    import_name = "@celld/ulid",
    visibility = ["PUBLIC"],
    exports = {".": "src/mod.ts"},
)

celld.test(
    name = "test",
    srcs = ["tests/ulid_test.ts"],
    deps = [
        "root//src/celld/assert:assert",
        ":ulid",
    ],
)

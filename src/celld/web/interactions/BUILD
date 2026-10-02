# SPDX-FileCopyrightText: © 2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

load("@toolchains//celld:defs.bzl", "celld")

celld.library(
    name = "interactions",
    srcs = glob(["src/*.ts"]),
    import_name = "@celld/web/interactions",
    visibility = ["PUBLIC"],
    exports = {".": "src/mod.ts"},
)

celld.test(
    name = "navigation-test",
    srcs = ["tests/navigation_test.ts"],
    deps = [
        "root//src/celld/core:core",
        ":interactions",
    ],
)

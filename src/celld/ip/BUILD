# SPDX-FileCopyrightText: © 2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

load("@toolchains//celld:defs.bzl", "celld")

celld.library(
    name = "ip",
    srcs = glob(["src/*.ts"]),
    import_name = "@celld/ip",
    visibility = ["PUBLIC"],
    exports = {
        ".": "src/mod.ts",
        "./patterns": "src/patterns.ts",
    },
)

[
    celld.test(
        name = "{}-test".format(suite),
        srcs = ["tests/{}_test.ts".format(suite)],
        deps = [
            "root//src/celld/assert:assert",
            ":ip",
        ],
    )
    for suite in [
        "address",
        "cidr",
        "patterns",
    ]
]

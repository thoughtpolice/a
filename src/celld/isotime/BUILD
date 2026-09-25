# SPDX-FileCopyrightText: © 2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

load("@toolchains//celld:defs.bzl", "celld")

celld.library(
    name = "isotime",
    srcs = glob(["src/*.ts"]),
    import_name = "@celld/isotime",
    visibility = ["PUBLIC"],
    exports = {".": "src/mod.ts"},
)

[
    celld.test(
        name = "{}-test".format(suite),
        srcs = ["tests/{}_test.ts".format(suite)],
        deps = [
            "root//src/celld/assert:assert",
            ":isotime",
        ],
    )
    for suite in [
        "datetime",
        "duration",
    ]
]

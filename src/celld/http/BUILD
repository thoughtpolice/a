# SPDX-FileCopyrightText: © 2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

load("@toolchains//celld:defs.bzl", "celld")

# Shared by the HTTP clients (jev, exedev, openai, mcp); depends on nothing.
celld.library(
    name = "http",
    srcs = glob(["src/*.ts"]),
    import_name = "@celld/http",
    visibility = ["PUBLIC"],
    exports = {
        ".": "src/mod.ts",
        "./sse": "src/sse.ts",
        "./testing": "src/testing.ts",
    },
)

[
    celld.test(
        name = "{}-test".format(suite),
        srcs = ["tests/{}_test.ts".format(suite)],
        deps = [
            "root//src/celld/assert:assert",
            ":http",
        ],
    )
    for suite in [
        "body",
        "retry",
        "runtime",
        "sse",
        "testing",
    ]
]

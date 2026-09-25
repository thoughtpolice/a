# SPDX-FileCopyrightText: © 2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

load("@toolchains//celld:defs.bzl", "celld")

# Shared by the HTTP clients (jev, exedev, openai, mcp). `./egress` needs
# bounds (streamed caps, bounded JSON) and ip (address classes).
celld.library(
    name = "http",
    srcs = glob(["src/*.ts"]),
    import_name = "@celld/http",
    visibility = ["PUBLIC"],
    exports = {
        ".": "src/mod.ts",
        "./egress": "src/egress.ts",
        "./sse": "src/sse.ts",
        "./testing": "src/testing.ts",
    },
    deps = [
        "root//src/celld/core:core",
    ],
)

[
    celld.test(
        name = "{}-test".format(suite),
        srcs = ["tests/{}_test.ts".format(suite)],
        deps = [
            "root//src/celld/core:core",
            ":http",
        ],
    )
    for suite in [
        "body",
        "egress",
        "retry",
        "runtime",
        "sse",
        "testing",
    ]
]

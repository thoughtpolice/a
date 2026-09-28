# SPDX-FileCopyrightText: © 2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

load("@toolchains//celld:defs.bzl", "celld")

celld.library(
    name = "realtime",
    srcs = glob(["src/*.ts"]),
    import_name = "@celld/web/realtime",
    visibility = ["PUBLIC"],
    exports = {
        ".": "src/mod.ts",
        "./client": "src/client.ts",
        "./durable": "src/durable.ts",
        "./router": "src/router.ts",
        "./testing": "src/testing.ts",
    },
    deps = [
        "root//src/celld/core:core",
        "root//src/celld/sec/ratelimit:ratelimit",
        "root//src/celld/web/router:router",
    ],
)

[
    celld.test(
        name = "{}-test".format(suite),
        srcs = ["tests/{}_test.ts".format(suite)],
        deps = [
            "root//src/celld/core:core",
            ":realtime",
        ] + (["root//src/celld/web/router:router"] if suite in [
            "readme",
            "router",
        ] else []),
    )
    for suite in [
        "client",
        "protocol",
        "readme",
        "room",
        "router",
    ]
]

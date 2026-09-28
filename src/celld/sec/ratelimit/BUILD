# SPDX-FileCopyrightText: © 2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

load("@toolchains//celld:defs.bzl", "celld")

celld.library(
    name = "ratelimit",
    srcs = glob(["src/*.ts"]),
    import_name = "@celld/sec/ratelimit",
    visibility = ["PUBLIC"],
    exports = {
        ".": "src/mod.ts",
        "./durable": "src/durable.ts",
        "./router": "src/router.ts",
        "./testing": "src/testing.ts",
    },
    deps = [
        "root//src/celld/core:core",
        "root//src/celld/http:http",
        "root//src/celld/web/router:router",
    ],
)

[
    celld.test(
        name = "{}-test".format(suite),
        srcs = ["tests/{}_test.ts".format(suite)],
        deps = [
            "root//src/celld/core:core",
            ":ratelimit",
        ] + (["root//src/celld/web/router:router"] if suite in [
            "readme",
            "router",
        ] else []) + (["root//src/celld/http:http"] if suite == "upstream" else []),
    )
    for suite in [
        "client",
        "gcra",
        "keys",
        "limiter",
        "policy",
        "readme",
        "router",
        "shard",
        "upstream",
    ]
]

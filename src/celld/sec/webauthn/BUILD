# SPDX-FileCopyrightText: © 2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

load("@toolchains//celld:defs.bzl", "celld")

celld.library(
    name = "webauthn",
    srcs = glob(["src/*.ts"]),
    import_name = "@celld/sec/webauthn",
    visibility = ["PUBLIC"],
    exports = {
        ".": "src/mod.ts",
        "./browser": "src/browser.ts",
        "./durable": "src/durable.ts",
        "./router": "src/router.ts",
        "./testing": "src/testing.ts",
    },
    deps = [
        "root//src/celld/core:core",
        "root//src/celld/sec/jwt:jwt",
        "root//src/celld/sec/ratelimit:ratelimit",
        "root//src/celld/web/router:router",
    ],
)

[
    celld.test(
        name = "{}-test".format(suite),
        srcs = ["tests/{}_test.ts".format(suite)] + extra,
        deps = [
            "root//src/celld/core:core",
            "root//src/celld/sec/jwt:jwt",
            ":webauthn",
        ] + ([
            "root//src/celld/web/router:router",
            "root//src/celld/sec/ratelimit:ratelimit",
        ] if suite in [
            "browser",
            "readme",
            "router",
        ] else []),
    )
    for suite, extra in [
        ("browser", []),
        ("cbor", []),
        ("cose", []),
        ("readme", []),
        ("rp", []),
        ("router", []),
        ("store", []),
        (
            "vectors",
            ["tests/vectors.json"],
        ),
    ]
]

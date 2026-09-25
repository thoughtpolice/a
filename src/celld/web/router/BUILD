# SPDX-FileCopyrightText: © 2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

load("@toolchains//celld:defs.bzl", "celld")

# OpenAPI export is a subpath the core never imports, so a Worker that does
# not serve a document does not carry `@celld/sieve/json-schema`.
celld.library(
    name = "router",
    srcs = glob(["src/*.ts"]),
    import_name = "@celld/web/router",
    visibility = ["PUBLIC"],
    exports = {
        ".": "src/mod.ts",
        "./openapi": "src/openapi.ts",
        "./client": "src/client.ts",
    },
    deps = [
        "root//src/celld/core:core",
        "root//src/celld/sec/jwt:jwt",
        "root//src/celld/sieve:sieve",
    ],
)

# One suite per concern; `types` fails `deno check` when inference regresses.
[
    celld.test(
        name = "{}-test".format(suite),
        srcs = [
            "tests/fixture.ts",
            "tests/{}_test.ts".format(suite),
        ],
        deps = [
            "root//src/celld/core:core",
            "root//src/celld/sec/jwt:jwt",
            "root//src/celld/sieve:sieve",
            ":router",
        ],
    )
    for suite in [
        "auth",
        "client",
        "client_types",
        "cookies",
        "cors",
        "csrf",
        "dpop",
        "dpop_types",
        "hooks",
        "hardening",
        "limits",
        "immutable",
        "mount",
        "openapi",
        "routing",
        "registration",
        "schemes",
        "security",
        "sweep",
        "transport",
        "types",
        "util",
        "validation",
    ]
]

# SPDX-FileCopyrightText: © 2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

load("@toolchains//celld:defs.bzl", "celld")

# OpenAPI export is a subpath the core never imports, so a Worker that does
# not serve a document does not carry `@celld/sieve/json-schema`.
celld.library(
    name = "router",
    srcs = glob(["src/*.ts"]),
    import_name = "@celld/router",
    visibility = ["PUBLIC"],
    exports = {
        ".": "src/mod.ts",
        "./openapi": "src/openapi.ts",
    },
    deps = [
        "root//src/celld/ip:ip",
        "root//src/celld/jwt:jwt",
        "root//src/celld/sieve:sieve",
        "root//src/celld/ulid:ulid",
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
            "root//src/celld/assert:assert",
            "root//src/celld/ip:ip",
            "root//src/celld/jwt:jwt",
            "root//src/celld/sieve:sieve",
            ":router",
        ],
    )
    for suite in [
        "auth",
        "cookies",
        "cors",
        "csrf",
        "hooks",
        "openapi",
        "routing",
        "schemes",
        "security",
        "types",
        "util",
        "validation",
    ]
]

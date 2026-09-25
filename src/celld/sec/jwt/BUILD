# SPDX-FileCopyrightText: © 2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

load("@toolchains//celld:defs.bzl", "celld")

celld.library(
    name = "jwt",
    srcs = glob(["src/*.ts"]),
    import_name = "@celld/sec/jwt",
    visibility = ["PUBLIC"],
    exports = {".": "src/mod.ts"},
    deps = [
        "root//src/celld/core:core",
        "root//src/celld/http:http",
    ],
)

# One suite per concern; `vectors` checks RFC 7515 and RFC 8037 examples.
[
    celld.test(
        name = "{}-test".format(suite),
        srcs = [
            "tests/fixture.ts",
            "tests/{}_test.ts".format(suite),
        ],
        deps = [
            "root//src/celld/core:core",
            ":jwt",
        ],
    )
    for suite in [
        "base64url",
        "decode",
        "jwks",
        "keys",
        "hardening",
        "performance",
        "regressions",
        "sign_verify",
        "vectors",
        "verifier",
    ]
]

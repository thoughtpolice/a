# SPDX-FileCopyrightText: © 2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

load("@toolchains//celld:defs.bzl", "celld")

celld.library(
    name = "jwt",
    srcs = glob(["src/*.ts"]),
    import_name = "@celld/jwt",
    visibility = ["PUBLIC"],
    exports = {".": "src/mod.ts"},
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
            "root//src/celld/assert:assert",
            ":jwt",
        ],
    )
    for suite in [
        "base64url",
        "decode",
        "jwks",
        "keys",
        "sign_verify",
        "vectors",
    ]
]

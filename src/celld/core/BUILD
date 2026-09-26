# SPDX-FileCopyrightText: © 2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

load("@toolchains//celld:defs.bzl", "celld")

# The modules every other celld library builds on; depends on nothing. Each
# is imported by its own subpath, so a Worker bundles only what it uses.
celld.library(
    name = "core",
    srcs = glob(["src/**/*.ts"]),
    import_name = "@celld/core",
    visibility = ["PUBLIC"],
    exports = {
        "./assert": "src/assert/mod.ts",
        "./bounds": "src/bounds/mod.ts",
        "./ip": "src/ip/mod.ts",
        "./ip/patterns": "src/ip/patterns.ts",
        "./isotime": "src/isotime/mod.ts",
        "./ulid": "src/ulid/mod.ts",
    },
)

[
    celld.test(
        name = "{}-test".format(suite.replace("/", "-")),
        srcs = ["tests/{}_test.ts".format(suite)],
        deps = [":core"],
    )
    for suite in [
        "assert",
        "ip/address",
        "ip/cidr",
        "ip/patterns",
        "isotime/datetime",
        "isotime/duration",
        "ulid",
    ]
]

# The bounds suites compare with their own stricter assertions; see
# tests/bounds/assert.ts.
[
    celld.test(
        name = "bounds-{}-test".format(suite),
        srcs = [
            "tests/bounds/assert.ts",
            "tests/bounds/{}_test.ts".format(suite),
        ],
        deps = [":core"],
    )
    for suite in [
        "collections",
        "json",
        "numbers",
        "objects",
        "read",
    ]
]

# SPDX-FileCopyrightText: © 2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

load("@toolchains//celld:defs.bzl", "celld")

# Everything but `./durable` is free of "cloudflare:workers", so it loads in
# plain Deno tests; `./testing` runs host processes with Deno.Command.
celld.library(
    name = "container",
    srcs = glob(["src/*.ts"]),
    import_name = "@celld/container",
    visibility = ["PUBLIC"],
    exports = {
        ".": "src/mod.ts",
        "./durable": "src/durable.ts",
        "./testing": "src/testing.ts",
    },
)

# One suite per concern. `fake` runs real host processes through the fake
# container; `durable` loads the Durable Object class on the fake runtime.
[
    celld.test(
        name = "{}-test".format(suite),
        srcs = [
            "tests/fixture.ts",
            "tests/{}_test.ts".format(suite),
        ],
        fake_runtime = suite == "durable",
        permissions = [
            "env",
            "read",
            "run",
            "write",
        ] if suite == "fake" else [],
        deps = [
            "root//src/celld/assert:assert",
            ":container",
        ],
    )
    for suite in [
        "controller",
        "duration",
        "durable",
        "fake",
    ]
]

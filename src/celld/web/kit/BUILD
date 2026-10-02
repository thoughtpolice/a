# SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

load("@toolchains//celld:defs.bzl", "celld")

celld.library(
    name = "kit",
    srcs = ["src/focus.ts"],
    import_name = "@celld/web/kit",
    svelte_runtime = True,
    visibility = ["PUBLIC"],
    exports = {
        "./server": "src/server.ts",
        "./browser": "src/browser.ts",
        "./navigation": "src/navigation.ts",
        "./actions": "src/actions.ts",
    },
    deps = [
        "root//src/celld/core:core",
        "root//src/celld/sieve:sieve",
        "root//src/celld/web/router:router",
    ],
)

celld.test(
    name = "server-test",
    srcs = ["tests/server_test.ts"],
    deps = [
        "root//src/celld/core:core",
        "root//src/celld/sieve:sieve",
        "root//src/celld/web/router:router",
        "toolchains//celld/tests/svelte:page",
        ":kit",
    ],
)

[
    celld.test(
        name = "{}-test".format(suite),
        srcs = ["tests/{}_test.ts".format(suite)],
        deps = [
            "root//src/celld/core:core",
            "root//src/celld/sieve:sieve",
            "root//src/celld/web/router:router",
            ":kit",
        ],
    )
    for suite in [
        "navigation",
        "actions",
    ]
]

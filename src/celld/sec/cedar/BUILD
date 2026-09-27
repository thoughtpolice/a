# SPDX-FileCopyrightText: © 2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

load("@root//buck/shims:shims.bzl", depot = "shims")
load("@toolchains//celld:defs.bzl", "celld")

celld.library(
    name = "cedar",
    srcs = glob(["src/*.ts"]),
    import_name = "@celld/sec/cedar",
    visibility = ["PUBLIC"],
    wasm = {"./wasm": "third-party//by-name/ce/cedar-wasm:wasm"},
    exports = {
        ".": "src/mod.ts",
        "./query": "src/query.ts",
        "./router": "src/router.ts",
        "./sql": "src/sql.ts",
        "./store": "src/store.ts",
        "./testing": "src/testing.ts",
    },
    deps = ["root//src/celld/web/router:router"],
)

# One suite per concern, all against the real cedar-wasm module.
[
    celld.test(
        name = "{}-test".format(suite),
        srcs = [
            "tests/fixture.ts",
            "tests/{}_test.ts".format(suite),
        ],
        deps = [
            "root//src/celld/core:core",
            ":cedar",
        ] + (["root//src/celld/web/router:router"] if suite == "router" else []),
    )
    for suite in [
        "authorizer",
        "engine",
        "policies",
        "query",
        "readme",
        "router",
        "schema",
        "sql",
        "store",
        "testing",
        "values",
    ]
]

# A Worker running the store and query suites in a Durable Object, for the
# runtime test below.
celld.worker(
    name = "runtime-worker",
    srcs = ["tests/fixture.ts"],
    main = "tests/runtime/worker.ts",
    deps = [":cedar"],
)

celld.project(
    name = "runtime-project",
    src = ":runtime-worker",
    bindings = {"RUNTIME": "CedarRuntime"},
    script_name = "cedar-runtime-test",
)

celld.deploy_test(
    name = "deploy-test",
    project = ":runtime-project",
)

depot.python_binary(
    name = "runtime-test-runner",
    main = "tests/runtime_test.py",
)

# Runs the project under `celld dev` over loopback HTTP, restarting the
# supervisor to check what must be durable; no network.
depot.command_test(
    name = "runtime-test",
    cmd = [
        "$(exe :runtime-test-runner)",
        "$(exe toolchains//celld:cli)",
        "$(location :runtime-project)",
    ],
)

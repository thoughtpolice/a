# SPDX-FileCopyrightText: © 2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

load("@root//buck/shims:shims.bzl", depot = "shims")
load("@toolchains//celld:defs.bzl", "celld")

# Everything but `./durable` is free of "cloudflare:workers", so it loads in
# plain Deno tests.
celld.library(
    name = "exedev",
    srcs = glob(["src/*.ts"]),
    import_name = "@celld/api/exedev",
    visibility = ["PUBLIC"],
    exports = {
        ".": "src/mod.ts",
        "./durable": "src/durable.ts",
        "./fleet": "src/fleet.ts",
        "./limiter": "src/limiter.ts",
        "./proxy": "src/proxy.ts",
        "./testing": "src/testing.ts",
        "./vm": "src/vm.ts",
        "./workflow": "src/workflow.ts",
    },
    deps = [
        "root//src/celld/http:http",
        "root//src/celld/ip:ip",
        "root//src/celld/isotime:isotime",
        "root//src/celld/jwt:jwt",
        "root//src/celld/router:router",
        "root//src/celld/sieve:sieve",
        "root//src/celld/ulid:ulid",
    ],
)

# One suite per concern. The token fixture is shared test data.
[
    celld.test(
        name = "{}-test".format(suite),
        srcs = [
            "tests/{}_test.ts".format(suite),
            "tests/fixtures.ts",
        ],
        deps = [
            "root//src/celld/assert:assert",
            "root//src/celld/router:router",
            ":exedev",
        ],
    )
    for suite in [
        "api",
        "client",
        "command",
        "decode",
        "errors",
        "fake",
        "fleet",
        "proxy",
        "quote",
        "tokens",
        "vm",
        "workflow",
    ]
]

# A Worker using the client, minting, the fleet and limiter Durable Objects
# and a provisioning Workflow, for the runtime test below.
celld.worker(
    name = "runtime-worker",
    srcs = ["tests/fixtures.ts"],
    main = "tests/runtime/worker.ts",
    deps = [":exedev"],
)

celld.project(
    name = "runtime-project",
    src = ":runtime-worker",
    bindings = {
        "EXE_LIMITER": "ExeKeyLimiter",
        "FLEET": "TestFleet",
    },
    script_name = "exedev-runtime-test",
    # A stand-in for the secret binding a real deployment uses; the fake
    # lobby accepts it.
    vars = {"EXE_API_TOKEN": "exe1.runtime-test"},
    workflows = [{
        "binding": "PROVISION",
        "class_name": "ProvisionWorkflow",
        "name": "exedev-provision",
    }],
)

celld.deploy_test(
    name = "deploy-test",
    project = ":runtime-project",
)

depot.python_binary(
    name = "runtime-test-runner",
    main = "tests/runtime_test.py",
)

# Runs the project under `celld dev` against a fake lobby on loopback that
# runs VM commands through a real /bin/sh; no network or exe.dev account.
depot.command_test(
    name = "runtime-test",
    cmd = [
        "$(exe :runtime-test-runner)",
        "$(exe toolchains//celld:cli)",
        "$(location :runtime-project)",
    ],
)

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
        "./proxy": "src/proxy.ts",
        "./testing": "src/testing.ts",
        "./vm": "src/vm.ts",
        "./workflow": "src/workflow.ts",
    },
    deps = [
        "root//src/celld/core:core",
        "root//src/celld/http:http",
        "root//src/celld/sec/jwt:jwt",
        "root//src/celld/sec/ratelimit:ratelimit",
        "root//src/celld/sieve:sieve",
        "root//src/celld/web/router:router",
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
            "root//src/celld/core:core",
            "root//src/celld/sec/ratelimit:ratelimit",
            "root//src/celld/web/router:router",
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
        "regressions",
        "tokens",
        "vm",
        "workflow",
    ]
]

# The bootstrap and detach command lines through a real /bin/sh in a
# temporary directory (flock(1) must be on PATH).
celld.test(
    name = "bootstrap-shell-test",
    srcs = ["tests/bootstrap_shell_test.ts"],
    permissions = [
        "env",
        "read",
        "run",
        "write",
    ],
    deps = [
        "root//src/celld/core:core",
        ":exedev",
    ],
)

# A Worker using the client, minting, the fleet and rate limit Durable
# Objects and a provisioning Workflow, for the runtime test below.
celld.worker(
    name = "runtime-worker",
    srcs = ["tests/fixtures.ts"],
    main = "tests/runtime/worker.ts",
    deps = [
        "root//src/celld/sec/ratelimit:ratelimit",
        ":exedev",
    ],
)

celld.project(
    name = "runtime-project",
    src = ":runtime-worker",
    bindings = {
        "FLEET": "TestFleet",
        "RATE_LIMITS": "RateLimitShard",
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

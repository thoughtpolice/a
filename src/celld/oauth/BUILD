# SPDX-FileCopyrightText: © 2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

load("@root//buck/shims:shims.bzl", depot = "shims")
load("@toolchains//celld:defs.bzl", "celld")

# One library, one subpath per role: a Worker that only verifies tokens
# never loads the authorization server. Only `./durable` imports
# "cloudflare:workers", so everything else loads in a plain Deno test, and
# only `./router` imports @celld/router.
celld.library(
    name = "oauth",
    srcs = glob(["src/**/*.ts"]),
    import_name = "@celld/oauth",
    visibility = ["PUBLIC"],
    exports = {
        ".": "src/mod.ts",
        "./client": "src/client/mod.ts",
        "./dpop": "src/dpop/mod.ts",
        "./durable": "src/durable.ts",
        "./resource": "src/resource/mod.ts",
        "./router": "src/router.ts",
        "./server": "src/server/mod.ts",
        "./testing": "src/testing.ts",
    },
    deps = [
        "root//src/celld/ip:ip",
        "root//src/celld/jwt:jwt",
        "root//src/celld/router:router",
        "root//src/celld/sieve:sieve",
    ],
)

# One suite per concern. `core` and `dpop` check the RFC 7636 and RFC 9449
# examples; `flow` runs clients, authorization servers and resource servers
# against each other in one process; `durable` loads the Durable Object, so
# it needs the fake "cloudflare:workers".
[
    celld.test(
        name = "{}-test".format(suite),
        srcs = [
            "tests/fixture.ts",
            "tests/{}_test.ts".format(suite),
        ],
        fake_runtime = suite == "durable",
        deps = [
            "root//src/celld/assert:assert",
            "root//src/celld/jwt:jwt",
            ":oauth",
        ] + (["root//src/celld/router:router"] if suite == "router" else []),
    )
    for suite in [
        "client",
        "core",
        "dpop",
        "durable",
        "flow",
        "resource",
        "router",
        "server",
    ]
]

# A Worker serving an authorization server and a resource, with their
# records in the OAuthRecords Durable Object, for the runtime test below.
celld.worker(
    name = "runtime-worker",
    main = "tests/runtime/worker.ts",
    deps = [":oauth"],
)

celld.project(
    name = "runtime-project",
    src = ":runtime-worker",
    bindings = {"OAUTH_RECORDS": "OAuthRecords"},
    script_name = "oauth-runtime-test",
    # A stand-in for the secret binding a real deployment uses.
    vars = {"NONCE_SECRET": "runtime-test-nonce-secret-0123456789"},
)

celld.deploy_test(
    name = "deploy-test",
    project = ":runtime-project",
)

depot.python_binary(
    name = "runtime-test-runner",
    main = "tests/runtime_test.py",
)

# Runs the project under `celld dev` and drives it over loopback HTTP,
# restarting the supervisor to check what must be durable; no network.
depot.command_test(
    name = "runtime-test",
    cmd = [
        "$(exe :runtime-test-runner)",
        "$(exe toolchains//celld:cli)",
        "$(location :runtime-project)",
    ],
)

# SPDX-FileCopyrightText: © 2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

load("@root//buck/shims:shims.bzl", depot = "shims")
load("@toolchains//celld:defs.bzl", "celld")

# The client, server and everything pure is `@celld/mcp`; only `./durable`
# imports "cloudflare:workers", so the rest loads in plain Deno tests. The
# HTTP endpoint is a `@celld/router` route, OAuth is `@celld/oauth` (the
# resource side through `@celld/oauth/router`, the client side through
# `OAuthSession`), tool schemas are `@celld/sieve`, and SSE framing is
# `@celld/http/sse`.
celld.library(
    name = "mcp",
    srcs = glob(["src/*.ts"]),
    import_name = "@celld/mcp",
    visibility = ["PUBLIC"],
    exports = {
        ".": "src/mod.ts",
        "./durable": "src/durable.ts",
        "./testing": "src/testing.ts",
    },
    deps = [
        "root//src/celld/http:http",
        "root//src/celld/jwt:jwt",
        "root//src/celld/oauth:oauth",
        "root//src/celld/router:router",
        "root//src/celld/sieve:sieve",
        "root//src/celld/ulid:ulid",
    ],
)

# One suite per concern; `subscriptions` loads the hub Durable Object, so it
# needs the fake "cloudflare:workers".
[
    celld.test(
        name = "{}-test".format(suite),
        srcs = [
            "tests/fixture.ts",
            "tests/{}_test.ts".format(suite),
        ],
        fake_runtime = suite == "subscriptions",
        deps = [
            "root//src/celld/assert:assert",
            "root//src/celld/http:http",
            "root//src/celld/jwt:jwt",
            "root//src/celld/oauth:oauth",
            "root//src/celld/router:router",
            "root//src/celld/sieve:sieve",
            ":mcp",
        ],
    )
    for suite in [
        "cache",
        "cancellation",
        "client",
        "framing",
        "headers",
        "http",
        "jsonschema",
        "mrtr",
        "oauth_client",
        "oauth_server",
        "progress",
        "server",
        "subscriptions",
        "tasks",
        "tasks_client",
    ]
]

# A Worker serving an MCP server (with the change hub) and using the client,
# for the runtime test below.
celld.worker(
    name = "runtime-worker",
    main = "tests/runtime/worker.ts",
    deps = [
        "root//src/celld/oauth:oauth",
        "root//src/celld/router:router",
        "root//src/celld/sieve:sieve",
        ":mcp",
    ],
)

celld.project(
    name = "runtime-project",
    src = ":runtime-worker",
    bindings = {
        "MCP_CHANGES": "McpChangeHub",
        "MCP_TASKS": "McpTasks",
    },
    script_name = "mcp-runtime-test",
    # A stand-in for the secret binding a real deployment uses.
    vars = {"MCP_STATE_SECRET": "runtime-test-secret-0123456789abcdef"},
)

celld.deploy_test(
    name = "deploy-test",
    project = ":runtime-project",
)

depot.python_binary(
    name = "runtime-test-runner",
    main = "tests/runtime_test.py",
)

# Runs the project under `celld dev` and speaks raw HTTP MCP to it; no
# network.
depot.command_test(
    name = "runtime-test",
    cmd = [
        "$(exe :runtime-test-runner)",
        "$(exe toolchains//celld:cli)",
        "$(location :runtime-project)",
    ],
)

# The live test on an exe.dev VM: `buck2 run :live-run -- <vm>.exe.xyz`.
# It deploys :runtime-project under `celld dev` on the VM and drives it with
# this client bundle from this machine (through exe.dev's HTTPS proxy) and
# from the VM, plus the official SDK. Nothing runs it automatically; see the
# README's "Live test".
celld.worker(
    name = "live-client",
    main = "tests/live/client.ts",
    deps = [
        "root//src/celld/oauth:oauth",
        ":mcp",
    ],
)

# Runs on the VM only, importing the official SDK through Deno's npm: support.
depot.export_file(
    name = "live-sdk-interop",
    src = "tests/live/sdk_interop.ts",
)

depot.python_binary(
    name = "live-runner",
    main = "tests/live_run.py",
)

depot.command(
    name = "live-run",
    cmd = [
        "$(exe :live-runner)",
        "--project",
        "$(location :runtime-project)",
        "--client",
        "$(location :live-client)",
        "--interop",
        "$(location :live-sdk-interop)",
        "--deno",
        "$(location root//buck/bin:deno)",
        "--celld-x86_64",
        "$(location toolchains//celld:0.5.1-x86_64-unknown-linux-gnu[archive])",
        "--celld-aarch64",
        "$(location toolchains//celld:0.5.1-aarch64-unknown-linux-gnu[archive])",
    ],
)

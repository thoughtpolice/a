# SPDX-FileCopyrightText: © 2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

load("@root//buck/shims:shims.bzl", depot = "shims")
load("@toolchains//celld:defs.bzl", "celld")

# The client and everything pure is `@celld/api/openai`; only `./durable` imports
# "cloudflare:workers", so the rest loads in plain Deno tests. Schemas are
# `@celld/sieve`, retries, the runtime and SSE `@celld/http`, and ids
# `@celld/ulid`; the bridges below carry every other library.
celld.library(
    name = "openai",
    srcs = glob(["src/*.ts"]),
    import_name = "@celld/api/openai",
    visibility = ["PUBLIC"],
    exports = {
        ".": "src/mod.ts",
        "./blueteam": "src/blueteam.ts",
        "./coding": "src/coding.ts",
        "./durable": "src/durable.ts",
        "./testing": "src/testing.ts",
        "./workflow": "src/workflow.ts",
    },
    deps = [
        "root//src/celld/http:http",
        "root//src/celld/sieve:sieve",
        "root//src/celld/ulid:ulid",
    ],
)

# Jev-gated approvals, routing and scoring. A target of its own so that the
# core does not depend on @celld/api/jev.
celld.library(
    name = "jev-bridge",
    srcs = ["bridges/jev.ts"],
    import_name = "@celld/api/openai/jev",
    visibility = ["PUBLIC"],
    exports = {".": "bridges/jev.ts"},
    deps = [
        "root//src/celld/api/jev:jev",
        ":openai",
    ],
)

# Integration discovery through exe.dev's reflection service.
celld.library(
    name = "reflection",
    srcs = ["bridges/reflection.ts"],
    import_name = "@celld/api/openai/reflection",
    visibility = ["PUBLIC"],
    exports = {".": "bridges/reflection.ts"},
    deps = [
        "root//src/celld/api/exedev:exedev",
        ":openai",
    ],
)

# The coding tools and Blue Team helpers over a @celld/sandbox sandbox.
celld.library(
    name = "sandbox-bridge",
    srcs = ["bridges/sandbox.ts"],
    import_name = "@celld/api/openai/sandbox",
    visibility = ["PUBLIC"],
    exports = {".": "bridges/sandbox.ts"},
    deps = [
        "root//src/celld/sandbox:sandbox",
        ":openai",
    ],
)

# One suite per concern; `pacer` loads the Durable Objects, so it needs the
# fake "cloudflare:workers".
[
    celld.test(
        name = "{}-test".format(suite),
        srcs = ["tests/{}_test.ts".format(suite)] + (
            ["tests/apply_patch_scenarios.ts"] if suite == "apply_patch" else []
        ),
        fake_runtime = suite == "pacer",
        deps = [
            "root//src/celld/assert:assert",
            "root//src/celld/http:http",
            "root//src/celld/sieve:sieve",
            ":openai",
        ],
    )
    for suite in [
        "agent",
        "apply_patch",
        "blueteam",
        "chunk",
        "client",
        "coding",
        "conversation",
        "errors",
        "events",
        "pacer",
        "request",
        "schema",
        "tools",
        "workflow",
    ]
]

# The JSON Schemas the model sees, against a checked-in golden file; after
# an intended change, update tests/golden/model-schemas.json by hand.
celld.test(
    name = "schema-golden-test",
    srcs = ["tests/schema_golden_test.ts"],
    data = ["tests/golden/model-schemas.json"],
    env = {
        "OPENAI_GOLDEN": "src/celld/api/openai/tests/golden/model-schemas.json",
    },
    permissions = [
        "env",
        "read",
    ],
    deps = [
        "root//src/celld/assert:assert",
        "root//src/celld/sieve:sieve",
        ":openai",
    ],
)

celld.test(
    name = "jev-bridge-test",
    srcs = ["tests/jev_bridge_test.ts"],
    deps = [
        "root//src/celld/api/jev:jev",
        "root//src/celld/assert:assert",
        "root//src/celld/sieve:sieve",
        ":jev-bridge",
        ":openai",
    ],
)

celld.test(
    name = "reflection-test",
    srcs = ["tests/reflection_test.ts"],
    deps = [
        "root//src/celld/api/exedev:exedev",
        "root//src/celld/assert:assert",
        ":openai",
        ":reflection",
    ],
)

# Runs the adapters over `@celld/sandbox/testing`'s local sandbox, whose
# exec runs host processes in a temporary directory.
celld.test(
    name = "sandbox-bridge-test",
    srcs = ["tests/sandbox_bridge_test.ts"],
    permissions = [
        "env",
        "read",
        "run",
        "write",
    ],
    deps = [
        "root//src/celld/assert:assert",
        "root//src/celld/sandbox:sandbox",
        ":openai",
        ":sandbox-bridge",
    ],
)

# A Worker using the client, both Durable Objects and an agent Workflow, for
# the runtime test below.
celld.worker(
    name = "runtime-worker",
    main = "tests/runtime/worker.ts",
    deps = [
        "root//src/celld/sieve:sieve",
        ":openai",
    ],
)

celld.project(
    name = "runtime-project",
    src = ":runtime-worker",
    bindings = {
        "GPT_CONVERSATIONS": "GptConversations",
        "GPT_PACER": "GptPacer",
    },
    script_name = "openai-runtime-test",
    workflows = [{
        "binding": "AGENT",
        "class_name": "AgentWorkflow",
        "name": "openai-agent",
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

# Runs the project under `celld dev` against a fake Codex backend on
# loopback; no network, account or subscription.
depot.command_test(
    name = "runtime-test",
    cmd = [
        "$(exe :runtime-test-runner)",
        "$(exe toolchains//celld:cli)",
        "$(location :runtime-project)",
    ],
)

# A live smoke test against a real ChatGPT-backed integration, bundled into
# one ESM file for Deno on an exe.dev VM. Nothing runs it automatically; see
# the README's "Live smoke test".
celld.worker(
    name = "live-smoke",
    main = "tests/live/smoke.ts",
    deps = [
        "root//src/celld/api/jev:jev",
        "root//src/celld/sieve:sieve",
        ":jev-bridge",
        ":openai",
    ],
)

depot.python_binary(
    name = "live-smoke-runner",
    main = "tests/live_smoke.py",
)

# `buck2 run :live-smoke-run -- my-vm.exe.xyz --integration chatgpt`
depot.command(
    name = "live-smoke-run",
    cmd = [
        "$(exe :live-smoke-runner)",
        "$(location :live-smoke)",
        "$(location root//buck/bin:deno)",
    ],
)

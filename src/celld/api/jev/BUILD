# SPDX-FileCopyrightText: © 2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

load("@root//buck/shims:shims.bzl", depot = "shims")
load("@root//src/celld/sieve:defs.bzl", "sieve_json_schema")
load("@toolchains//celld:defs.bzl", "celld")

# The client and everything pure is `@celld/api/jev`; only `./durable` imports
# "cloudflare:workers", so the rest loads in plain Deno tests. Retries, the
# runtime and the test clock come from @celld/http, validation from
# @celld/sieve.
celld.library(
    name = "jev",
    srcs = glob(["src/*.ts"]),
    import_name = "@celld/api/jev",
    visibility = ["PUBLIC"],
    exports = {
        ".": "src/mod.ts",
        "./cache": "src/cache.ts",
        "./durable": "src/durable.ts",
        "./limiter": "src/limiter.ts",
        "./schemas": "src/schemas.ts",
        "./testing": "src/testing.ts",
        "./workflow": "src/workflow.ts",
    },
    deps = [
        "root//src/celld/http:http",
        "root//src/celld/sieve:sieve",
    ],
)

# One suite per concern; `durable` needs the fake "cloudflare:workers".
[
    celld.test(
        name = "{}-test".format(suite),
        srcs = ["tests/{}_test.ts".format(suite)],
        fake_runtime = suite == "limiter",
        deps = [
            "root//src/celld/assert:assert",
            "root//src/celld/sieve:sieve",
            ":jev",
        ],
    )
    for suite in [
        "builders",
        "cache",
        "client",
        "decode",
        "errors",
        "helpers",
        "limiter",
        "retry",
        "schemas",
        "workflow",
    ]
]

# The request and response schemas' JSON Schema, written at build time.
sieve_json_schema(
    name = "schemas-json-schema",
    module = "@celld/api/jev/schemas",
    deps = [":jev"],
)

# Builds the bundle above and compares it with the checked-in golden file;
# after an intended change, copy the built file
# (`buck2 build :schemas-json-schema --show-output`) over the golden one.
celld.test(
    name = "schemas-golden-test",
    srcs = ["tests/schemas_golden_test.ts"],
    data = ["tests/golden/schemas.schema.json"],
    env = {
        "JEV_SCHEMA_EMITTED": "$(location :schemas-json-schema)",
        "JEV_SCHEMA_GOLDEN": "src/celld/api/jev/tests/golden/schemas.schema.json",
    },
    permissions = [
        "env",
        "read",
    ],
    deps = ["root//src/celld/assert:assert"],
)

# A Worker using the client, the limiter Durable Object and the KV cache,
# for the runtime test below.
celld.worker(
    name = "runtime-worker",
    main = "tests/runtime/worker.ts",
    deps = [":jev"],
)

celld.project(
    name = "runtime-project",
    src = ":runtime-worker",
    bindings = {"JEV_LIMITER": "JevRateLimiter"},
    kv_namespaces = {"JEV_CACHE": "jev-runtime-test-cache"},
    script_name = "jev-runtime-test",
    # A stand-in for the secret binding a real deployment uses.
    vars = {"TYPESAFE_API_KEY": "test-key"},
)

celld.deploy_test(
    name = "deploy-test",
    project = ":runtime-project",
)

depot.python_binary(
    name = "runtime-test-runner",
    main = "tests/runtime_test.py",
)

# Runs the project under `celld dev` against a fake TypeSafe server on
# loopback; no network or API key.
depot.command_test(
    name = "runtime-test",
    cmd = [
        "$(exe :runtime-test-runner)",
        "$(exe toolchains//celld:cli)",
        "$(location :runtime-project)",
    ],
)

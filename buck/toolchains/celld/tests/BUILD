# SPDX-FileCopyrightText: © 2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

load("@root//buck/shims:shims.bzl", "shims")
load("@toolchains//celld:defs.bzl", "celld")

# Runtime-owned imports must survive TypeScript/JavaScript bundling: celld, not
# Deno or an npm shim, supplies the implementation of cloudflare:workers.
celld.worker(
    name = "bindings-worker",
    main = "worker.js",
)

# A consumer script (no fetch handler), covering every supported binding family.
celld.project(
    name = "bindings-project",
    src = ":bindings-worker",
    assets = ":assets",
    assets_binding = "ASSETS",
    assets_html_handling = "auto-trailing-slash",
    assets_not_found_handling = "404-page",
    assets_run_worker_first_routes = ["/api/*"],
    bindings = {"COUNTER": "Counter"},
    compatibility_flags = ["queue_json_messages"],
    crons = ["0 * * * *"],
    d1_database_ids = {"DATABASE": "toolchain-database-v1"},
    d1_databases = {"DATABASE": "toolchain-database"},
    kv_namespaces = {"CACHE": "toolchain-cache-v1"},
    queue_consumers = [{
        "queue": "toolchain-jobs",
        "max_batch_size": 10,
        "max_batch_timeout": 1,
        "max_retries": 2,
        "max_concurrency": 1,
        "retry_delay": 1,
        "dead_letter_queue": "toolchain-dead-letters",
    }],
    queue_producers = [{
        "binding": "JOBS",
        "queue": "toolchain-jobs",
        "delivery_delay": 1,
    }],
    r2_buckets = {"ARTIFACTS": "toolchain-artifacts"},
    script_name = "celld-toolchain-test",
    service_entrypoints = {"OPERATIONS": "Operations"},
    services = {"OPERATIONS": "celld-toolchain-test"},
    vars = {"MODE": "test"},
    worker_loaders = [
        "LOADER",
        "OTHER_LOADER",
    ],
    workflows = [{
        "binding": "FLOW",
        "name": "toolchain-flow",
        "class_name": "ExampleWorkflow",
        "script_name": "celld-toolchain-test",
    }],
)

shims.filegroup(
    name = "assets",
    srcs = ["index.html"],
)

# Also protect the minimal no-bindings case, without any asset or service setup.
celld.project(
    name = "minimal-project",
    src = "minimal.js",
    script_name = "celld-minimal-test",
)

celld.deploy_test(
    name = "bindings-test",
    project = ":bindings-project",
)

celld.deploy_test(
    name = "minimal-test",
    project = ":minimal-project",
)

# Building this package copies a Dockerfile; it never contacts an engine.
# Do not add a deploy_test: even deploy --dry-run builds/pulls container images.
shims.filegroup(
    name = "container-context",
    srcs = ["Dockerfile"],
)

celld.project(
    name = "container-project",
    src = ":bindings-worker",
    bindings = {"COUNTER": "Counter"},
    container_context = ":container-context",
    containers = [{
        "class_name": "Counter",
        "image": "container/Dockerfile",
        "name": "toolchain-container",
        "instance_type": "dev",
        "max_instances": 2,
        "runtime": "runsc",
    }],
    script_name = "celld-container-test",
)

shims.python_binary(
    name = "packaging-test-runner",
    main = "packaging_test.py",
)

# Check exact configuration and dry-run results, plus upstream rejections. The
# runner never deploys a valid container project, and disables the Docker CLI.
shims.command_test(
    name = "packaging-test",
    cmd = [
        "$(exe :packaging-test-runner)",
        "$(exe toolchains//celld:cli)",
        "$(location :bindings-project)",
        "$(location :minimal-project)",
        "$(location :container-project)",
    ],
)

# Real dev-mode contracts live with the platform toolchain, not an application.
# Projects are plain JavaScript: celld receives no Wrangler/bundler step.
celld.project(
    name = "promise-tail-project",
    src = "promise_tail.js",
    bindings = {"SERIAL": "Serial"},
    script_name = "celld-promise-tail-test",
)

celld.project(
    name = "rpc-runtime-project",
    src = "rpc_runtime.js",
    bindings = {"OBJECT": "RPCObject"},
    script_name = "celld-rpc-runtime-test",
    service_entrypoints = {"SERVICE": "RPCService"},
    services = {"SERVICE": "celld-rpc-runtime-test"},
)

celld.project(
    name = "workflow-runtime-project",
    src = "workflow_runtime.js",
    script_name = "celld-workflow-runtime-test",
    workflows = [{
        "binding": "FLOW",
        "name": "contract-flow",
        "class_name": "ContractWorkflow",
    }],
)

shims.python_binary(
    name = "runtime-test-runner",
    main = "runtime_test.py",
)

shims.command_test(
    name = "runtime-test",
    cmd = [
        "$(exe :runtime-test-runner)",
        "$(exe toolchains//celld:cli)",
        "$(location :promise-tail-project)",
        "$(location :workflow-runtime-project)",
        "$(location :rpc-runtime-project)",
    ],
    visibility = ["PUBLIC"],
)

# Type-only contracts: Deno checks the bodies but does not invoke real bindings.
celld.test(
    name = "types-test",
    srcs = ["types_test.ts"],
)

shims.test_suite(
    name = "tests",
    tests = [
        "toolchains//celld:version-check",
        "toolchains//celld/tests/lib:tests",
        ":bindings-test",
        ":minimal-test",
        ":packaging-test",
        ":runtime-test",
        ":types-test",
    ],
)

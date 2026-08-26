# SPDX-FileCopyrightText: © 2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

load("@root//buck/shims:shims.bzl", depot = "shims")
load("@root//src/chaos3:defs.bzl", "chaos3_local_resource")
load("@toolchains//celld:defs.bzl", "celld")
load(
    ":defs.bzl",
    "celld_e2e_test",
    "orchestra_buck",
    "orchestra_deploy",
    "orchestra_tdutil",
)

celld.binary(
    name = "celld",
)

# Every module either Worker script reaches; the two bundles share them.
_WORKER_SRCS = [
    "src/agent_broker.ts",
    "src/epoch_ledger.ts",
    "src/epoch_workflow.ts",
    "src/facf/distribution.ts",
    "src/facf/index.ts",
    "src/facf/search.ts",
    "src/history.ts",
    "src/model.ts",
    "src/notifications.ts",
    "src/queue_consumer.ts",
    "src/repository.ts",
    "src/router.ts",
    "src/util/artifacts.ts",
    "src/util/constants.ts",
    "src/util/finalization.ts",
    "src/util/history.ts",
    "src/util/http.ts",
    "src/util/identifiers.ts",
    "src/util/objects.ts",
    "src/util/planning.ts",
    "src/util/policy.ts",
    "src/util/requests.ts",
    "src/util/rpc.ts",
    "src/util/scheduling.ts",
    "src/util/workflow.ts",
    "src/util/workflow_history.ts",
    "src/worker.ts",
]

celld.worker(
    name = "worker",
    srcs = _WORKER_SRCS,
    main = "src/index.ts",
)

[
    celld.project(
        name = project_name,
        src = ":worker",
        bindings = {
            "REPOSITORY": "Repository",
            "EPOCH": "EpochLedger",
            "JOB_QUEUE": "AgentBroker",
        },
        d1_database_ids = {
            "HISTORY": "orchestra-history-v1",
        },
        d1_databases = {
            "HISTORY": "orchestra-history",
        },
        queue_producers = [{
            "binding": "EVENTS",
            "queue": "orchestra-events",
        }],
        r2_buckets = {"ARTIFACTS": "orchestra-artifacts"},
        script_name = "orchestra",
        vars = {"WORKFLOW_WAKE_MODE": wake_mode},
        workflows = [{
            "binding": "EPOCH_RUNS",
            "name": "orchestra-epoch",
            "class_name": "EpochWorkflow",
        }],
    )
    for project_name, wake_mode in [
        ("worker-project", "poll"),
        ("worker-project-events", "events"),
    ]
]

celld.worker(
    name = "queue-consumer",
    srcs = _WORKER_SRCS,
    main = "src/queue_consumer.ts",
)

# Queue handlers are a separate Worker. The service binding invokes only the
# API's named Notifications entrypoint, never a public HTTP reconciliation URL.
celld.project(
    name = "queue-consumer-project",
    src = ":queue-consumer",
    queue_consumers = [{
        "queue": "orchestra-events",
        "max_batch_size": 10,
        "max_batch_timeout": 1,
        "max_retries": 10,
        "retry_delay": 1,
        "dead_letter_queue": "orchestra-events-dlq",
    }],
    script_name = "orchestra-notifications",
    service_entrypoints = {"ORCHESTRA": "Notifications"},
    services = {"ORCHESTRA": "orchestra"},
)

orchestra_deploy(
    name = "deploy",
    consumer_project = ":queue-consumer-project",
    project = ":worker-project",
    runner = ":e2e-runner",
)

celld.serve(
    name = "serve",
)

depot.go_binary(
    name = "orchestra",
    srcs = [
        "command_output.go",
        "culprit.go",
        "executor.go",
        "lease.go",
        "main.go",
        "planner.go",
        "source_repository.go",
    ],
    cgo_enabled = False,
    link_mode = "internal",
)

orchestra_tdutil(
    name = "tdutil-plan",
    buck = "root//buck/bin:buck2",
    command = "plan",
    orchestra = ":orchestra",
    tdutil = "root//buck/tools/tdutil:tdutil",
    universes = ["depot-tilde//aseipp/orchestra/..."],
)

orchestra_buck(
    name = "buck-execute",
    buck = "root//buck/bin:buck2",
    command = "execute",
    orchestra = ":orchestra",
)

orchestra_buck(
    name = "local-agent",
    buck = "root//buck/bin:buck2",
    command = "agent",
    orchestra = ":orchestra",
    tdutil = "root//buck/tools/tdutil:tdutil",
    universes = ["depot-tilde//aseipp/orchestra/..."],
)

orchestra_tdutil(
    name = "tdutil-agent",
    buck = "root//buck/bin:buck2",
    command = "agent",
    orchestra = ":orchestra",
    tdutil = "root//buck/tools/tdutil:tdutil",
    universes = ["depot-tilde//aseipp/orchestra/..."],
)

depot.go_binary(
    name = "e2e-runner",
    srcs = [
        "e2e/leases.go",
        "e2e/main.go",
    ],
    cgo_enabled = False,
    link_mode = "internal",
)

depot.go_test(
    name = "e2e-runner-test",
    srcs = [
        "e2e/leases.go",
        "e2e/leases_test.go",
        "e2e/main.go",
        "e2e/main_test.go",
    ],
)

chaos3_local_resource(
    name = "chaos3-resource",
)

celld_e2e_test(
    name = "e2e-test",
    chaos3 = ":chaos3-resource",
    consumer_project = ":queue-consumer-project",
    orchestra = ":orchestra",
    project = ":worker-project",
    runner = ":e2e-runner",
)

# Explicit diagnostic, not part of :tests: the same restart/FACF assertions
# reproduce intermittent Workflow status SQLite locks through celld 0.5.1 event mode.
celld_e2e_test(
    name = "e2e-events-test",
    chaos3 = ":chaos3-resource",
    consumer_project = ":queue-consumer-project",
    orchestra = ":orchestra",
    project = ":worker-project-events",
    runner = ":e2e-runner",
)

depot.go_test(
    name = "orchestra-test",
    srcs = [
        "command_output.go",
        "command_output_test.go",
        "culprit.go",
        "culprit_test.go",
        "executor.go",
        "executor_test.go",
        "lease.go",
        "lease_test.go",
        "main.go",
        "main_test.go",
        "planner.go",
        "planner_test.go",
        "source_repository.go",
        "source_repository_test.go",
    ],
)

# The fake runtime stands in for "cloudflare:workers", so the tests construct
# the Durable Object and Workflow classes themselves.
celld.test(
    name = "worker-test",
    srcs = _WORKER_SRCS + [
        "src/agent_broker_test.ts",
        "src/epoch_workflow_test.ts",
        "src/facf/search_test.ts",
        "src/finalization_test.ts",
        "src/index.ts",
        "src/rpc_ledger_test.ts",
        "src/rpc_test.ts",
        "src/util/planning_test.ts",
        "src/util/policy_test.ts",
        "src/util/scheduling_test.ts",
        "src/util/testing.ts",
        "src/util/workflow_test.ts",
        "src/worker_test.ts",
        "src/workflow_lifecycle_test.ts",
    ],
    fake_runtime = True,
)

# Keep the application's test command while the toolchain owns its contracts.
depot.alias(
    name = "celld-types-test",
    actual = "toolchains//celld/tests:types-test",
)

depot.test_suite(
    name = "tests",
    tests = [
        "toolchains//celld/tests:runtime-test",
        ":celld-types-test",
        ":e2e-runner-test",
        ":e2e-test",
        ":orchestra-test",
        ":worker-test",
    ],
)

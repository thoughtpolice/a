# SPDX-FileCopyrightText: © 2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

load("@root//buck/shims:shims.bzl", depot = "shims")
load("@toolchains//celld:defs.bzl", "celld")

# The Segment cell and what the layers above it share: its request/result
# types, the pure segment logic, the HTTP helpers and the retry chain. The
# journal bundles the Segment Durable Object from here too.
celld.library(
    name = "segment",
    srcs = ["src/types.ts"],
    import_name = "@wormspace/segment",
    visibility = ["PUBLIC"],
    exports = {
        ".": "src/segment.ts",
        "./core": "src/core.ts",
        "./http": "src/http.ts",
        "./serial": "src/serial.ts",
        "./types": "src/types.ts",
    },
)

# WormLog and WormPaxos: the runtime-free logic the Sequencer and Replica
# cells and the Worker's routes run.
celld.library(
    name = "layers",
    import_name = "@wormspace/layers",
    exports = {
        "./chain": "src/chain.ts",
        "./entry": "src/entry.ts",
        "./layers_http": "src/layers_http.ts",
        "./replica_core": "src/replica_core.ts",
        "./sequencer_core": "src/sequencer_core.ts",
        "./wormlog": "src/wormlog.ts",
    },
    deps = [":segment"],
)

# An in-memory stand-in for Segment cells and a seeded generator, for the
# model tests here and in the journal.
celld.library(
    name = "testing",
    import_name = "@wormspace/testing",
    visibility = ["PUBLIC"],
    exports = {
        "./fake_segment": "tests/fake_segment.ts",
        "./random": "tests/random.ts",
    },
    deps = [":segment"],
)

# Each suite with the test helpers it imports besides the libraries.
[
    celld.test(
        name = "{}-test".format(suite.replace("_", "-")),
        srcs = ["tests/{}_test.ts".format(suite)] + helpers,
        deps = [
            "root//src/celld/assert:assert",
            ":layers",
            ":segment",
            ":testing",
        ],
    )
    for suite, helpers in {
        "chain": [],
        "core": [],
        "entry": [],
        "fake_segment": ["tests/model.ts"],
        "http": [],
        "layers_http": [],
        "model": ["tests/model.ts"],
        "replica": ["tests/memory_stores.ts"],
        "replica_model": ["tests/memory_stores.ts"],
        "wormlog": ["tests/memory_stores.ts"],
        "wormlog_model": ["tests/memory_stores.ts"],
    }.items()
]

# The Durable Objects and routes. celld, not Deno, supplies
# "cloudflare:workers": the import survives bundling, and everything else is
# inlined into one ESM file, which the project packages verbatim.
celld.worker(
    name = "worker",
    srcs = [
        "src/replica.ts",
        "src/sequencer.ts",
    ],
    main = "src/index.ts",
    # Every fleet node fetches the script from the bucket in 4 KiB chunks when
    # it starts, and the chaos profile cuts bodies short; fewer chunks, fewer
    # restarts lost to that.
    minify = True,
    deps = [
        ":layers",
        ":segment",
    ],
)

celld.project(
    name = "project",
    src = ":worker",
    bindings = {
        "REPLICAS": "Replica",
        "SEGMENTS": "Segment",
        "SEQUENCERS": "Sequencer",
    },
    script_name = "wormspace",
)

celld.deploy(
    name = "deploy",
    project = ":project",
)

celld.deploy_test(
    name = "deploy-test",
    project = ":project",
)

# A local supervisor for poking at the service by hand; not a test.
depot.command(
    name = "dev",
    cmd = [
        "$(exe toolchains//celld:cli)",
        "dev",
        "$(location :project)",
        "--logs",
    ],
)

depot.python_binary(
    name = "runtime-test-runner",
    main = "tests/runtime_test.py",
)

depot.command_test(
    name = "runtime-test",
    cmd = [
        "$(exe :runtime-test-runner)",
        "$(exe toolchains//celld:cli)",
        "$(location :project)",
    ],
)

# The shared fleet harness: chaos3 with its fault modes, the egress proxy, celld
# nodes, the supervisor, and the fixture that ties them together. It knows no
# application; each one brings its own client and workload. Wormspace is the
# bottom of the stack, so the harness lives here and the journal depends on it.
depot.python_library(
    name = "fleet-harness",
    srcs = {"celld_fleet.py": "tests/celld_fleet.py"},
    base_module = "",
    visibility = ["tilde//..."],
)

# The runner receives the pinned celld CLI, the chaos3 binary, and the packaged
# project, and owns everything else it starts.
depot.python_binary(
    name = "fleet-test-runner",
    base_module = "",
    main = "tests/fleet_test.py",
    deps = [":fleet-harness"],
)

depot.command_test(
    name = "fleet-test",
    cmd = [
        "$(exe :fleet-test-runner)",
        "$(exe toolchains//celld:cli)",
        "$(exe root//src/chaos3:chaos3)",
        "$(location :project)",
    ],
)

# The WormLog and WormPaxos scenarios share an HTTP client for their routes.
depot.python_library(
    name = "layer-client",
    srcs = {"layer_client.py": "tests/layer_client.py"},
    base_module = "",
    deps = [":fleet-harness"],
)

# One target per scenario, so each gets its own fleet and they run in parallel
# with `:fleet-test`.
[
    [
        depot.python_binary(
            name = "{}-fleet-test-runner".format(layer),
            base_module = "",
            main = "tests/{}_fleet_test.py".format(layer),
            deps = [
                ":fleet-harness",
                ":layer-client",
            ],
        ),
        depot.command_test(
            name = "{}-fleet-test".format(layer),
            cmd = [
                "$(exe :{}-fleet-test-runner)".format(layer),
                "$(exe toolchains//celld:cli)",
                "$(exe root//src/chaos3:chaos3)",
                "$(location :project)",
            ],
        ),
    ]
    for layer in [
        "wormlog",
        "wormpaxos",
    ]
]

depot.test_suite(
    name = "tests",
    tests = [
        ":chain-test",
        ":core-test",
        ":deploy-test",
        ":entry-test",
        ":fake-segment-test",
        ":fleet-test",
        ":http-test",
        ":layers-http-test",
        ":model-test",
        ":replica-model-test",
        ":replica-test",
        ":runtime-test",
        ":wormlog-fleet-test",
        ":wormlog-model-test",
        ":wormlog-test",
        ":wormpaxos-fleet-test",
    ],
)

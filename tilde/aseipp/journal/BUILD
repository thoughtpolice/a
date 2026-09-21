# SPDX-FileCopyrightText: © 2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

load("@root//buck/shims:shims.bzl", depot = "shims")
load("@toolchains//celld:defs.bzl", "celld")

# The journal's runtime-free modules: the decisions, link arithmetic, the
# coordinator over a store and the segments, and the HTTP edge. The
# coordinator reaches the records through wormspace's segments.
celld.library(
    name = "lib",
    import_name = "@journal",
    exports = {
        "./core": "src/core.ts",
        "./http": "src/http.ts",
        "./links": "src/links.ts",
        "./log": "src/log.ts",
        "./types": "src/types.ts",
    },
    deps = ["tilde//aseipp/wormspace:segment"],
)

# Each suite with the test helper it imports besides the libraries.
[
    celld.test(
        name = "{}-test".format(suite.replace("_", "-")),
        srcs = ["tests/{}_test.ts".format(suite)] + helpers,
        deps = [
            "root//src/celld/assert:assert",
            "tilde//aseipp/wormspace:segment",
            "tilde//aseipp/wormspace:testing",
            ":lib",
        ],
    )
    for suite, helpers in {
        "core": [],
        "http": [],
        "links": [],
        "log": ["tests/memory_store.ts"],
        "log_model": ["tests/memory_store.ts"],
        "model": [],
    }.items()
]

# The Journal Durable Object and routes, with wormspace's Segment class
# exported beside it. celld, not Deno, supplies "cloudflare:workers": the
# import survives bundling, and everything else is inlined into one ESM file,
# which the project packages verbatim.
celld.worker(
    name = "worker",
    srcs = ["src/journal.ts"],
    main = "src/index.ts",
    # Every fleet node fetches the script from the bucket when it starts, in
    # 4 KiB chunks; with the segment code bundled in, the unminified script
    # tripled, and a lossy store makes each extra chunk another restart risk.
    minify = True,
    deps = [
        "tilde//aseipp/wormspace:segment",
        ":lib",
    ],
)

celld.project(
    name = "project",
    src = ":worker",
    bindings = {
        "JOURNAL": "Journal",
        "SEGMENTS": "Segment",
    },
    script_name = "journal",
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

# The fleet suite: celld in real FLEET mode against chaos3, one Buck test per
# scenario so they run in parallel and a failure can be rerun on its own. Each
# runner receives the pinned celld CLI, the chaos3 binary, and the packaged
# project, and owns everything else it starts. chaos3, the proxy, the nodes,
# and the fixture come from wormspace's shared harness; this library adds the
# journal's client, writer, and audit.
depot.python_library(
    name = "fleet-harness",
    srcs = {"fleet_harness.py": "tests/fleet_harness.py"},
    base_module = "",
    deps = ["tilde//aseipp/wormspace:fleet-harness"],
)

[
    [
        depot.python_binary(
            name = "fleet-{}-runner".format(scenario),
            base_module = "",
            main = "tests/fleet_{}_test.py".format(scenario),
            deps = [":fleet-harness"],
        ),
        depot.command_test(
            name = "fleet-{}-test".format(scenario),
            cmd = [
                "$(exe :fleet-{}-runner)".format(scenario),
                "$(exe toolchains//celld:cli)",
                "$(exe root//src/chaos3:chaos3)",
                "$(location :project)",
            ],
        ),
    ]
    for scenario in [
        "basics",
        "chaos",
        "failover",
        "faults",
        "proxy",
    ]
]

depot.test_suite(
    name = "tests",
    tests = [
        ":core-test",
        ":deploy-test",
        ":fleet-basics-test",
        ":fleet-chaos-test",
        ":fleet-failover-test",
        ":fleet-faults-test",
        ":fleet-proxy-test",
        ":http-test",
        ":links-test",
        ":log-model-test",
        ":log-test",
        ":model-test",
        ":runtime-test",
    ],
)

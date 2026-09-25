# SPDX-FileCopyrightText: © 2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

load("@root//src/celld/examples:defs.bzl", "celld_example")
load("@toolchains//celld:defs.bzl", "celld")

# Everything but `./durable` is free of "cloudflare:workers"; `./testing`
# runs host processes with Deno.Command.
celld.library(
    name = "sandbox",
    srcs = glob(["src/*.ts"]),
    import_name = "@celld/box/sandbox",
    visibility = ["PUBLIC"],
    exports = {
        ".": "src/mod.ts",
        "./durable": "src/durable.ts",
        "./testing": "src/testing.ts",
    },
    deps = [
        "root//src/celld/box/container:container",
        "root//src/celld/core:core",
        "root//src/celld/http:http",
        "root//src/celld/sieve:sieve",
    ],
)

# One suite per concern. Most run the real core over host processes
# (`@celld/box/sandbox/testing`), so they need to run programs and use a
# temporary directory; `durable` loads the Durable Object on the fake runtime.
[
    celld.test(
        name = "{}-test".format(suite),
        srcs = [
            "tests/fixture.ts",
            "tests/{}_test.ts".format(suite),
        ],
        fake_runtime = suite == "durable",
        permissions = [
            "env",
            "read",
            "run",
            "write",
        ],
        deps = [
            "root//src/celld/box/container:container",
            "root//src/celld/core:core",
            ":sandbox",
        ] + (["root//src/celld/core:core"] if suite == "processes" else []),
    )
    for suite in [
        "durable",
        "exec",
        "files",
        "git",
        "hardening",
        "lease",
        "limits",
        "paths",
        "processes",
        "retention",
        "review",
        "scripted",
        "streams",
        "sweep",
    ]
]

# The real-container test: `integration.json` drives a busybox container
# under `celld dev` through the shared example harness. It needs a Docker
# engine (on PATH) and pulls the pinned image the first time, so it is
# labelled `needs-docker`; see README.md.
celld_example(
    name = "integration",
    bindings = {
        "HOSTILE": "HostileSandbox",
        "IDLE": "IdleSandbox",
        "SANDBOX": "TestSandbox",
        "SWEEPING": "SweepingSandbox",
    },
    container_context = "root//src/celld/box/container/image:image",
    containers = [
        {
            "class_name": name,
            "image": "container/Dockerfile",
            "instance_type": "dev",
            "max_instances": 2,
        }
        for name in [
            "HostileSandbox",
            "IdleSandbox",
            "SweepingSandbox",
            "TestSandbox",
        ]
    ],
    labels = ["needs-docker"],
    main = "tests/integration/worker.ts",
    script_name = "sandbox-integration",
    spec = "tests/integration/integration.json",
    deps = [":sandbox"],
)

# Required production acceptance lane; never substitute the runc refusal lane.
celld_example(
    name = "integration-runsc",
    bindings = {"HOSTILE": "HostileSandbox"},
    container_context = "root//src/celld/box/container/image:image",
    containers = [{
        "class_name": "HostileSandbox",
        "image": "container/Dockerfile",
        "instance_type": "dev",
        "max_instances": 2,
        "runtime": "runsc",
    }],
    labels = [
        "needs-docker",
        "needs-runsc",
    ],
    main = "tests/integration/worker.ts",
    script_name = "sandbox-runsc-integration",
    spec = "tests/integration/runsc.json",
    deps = [":sandbox"],
)

# SPDX-FileCopyrightText: © 2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

load("@root//src/celld/examples:defs.bzl", "celld_example")
load("@toolchains//celld:defs.bzl", "celld")

# Everything but `./durable` is free of "cloudflare:workers"; `./testing`
# runs host processes with Deno.Command.
celld.library(
    name = "sandbox",
    srcs = glob(["src/*.ts"]),
    import_name = "@celld/sandbox",
    visibility = ["PUBLIC"],
    exports = {
        ".": "src/mod.ts",
        "./durable": "src/durable.ts",
        "./testing": "src/testing.ts",
    },
    deps = [
        "root//src/celld/container:container",
        "root//src/celld/sieve:sieve",
        "root//src/celld/ulid:ulid",
    ],
)

# One suite per concern. Most run the real core over host processes
# (`@celld/sandbox/testing`), so they need to run programs and use a
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
            "root//src/celld/assert:assert",
            "root//src/celld/container:container",
            ":sandbox",
        ] + (["root//src/celld/ulid:ulid"] if suite == "processes" else []),
    )
    for suite in [
        "durable",
        "exec",
        "files",
        "paths",
        "processes",
        "scripted",
    ]
]

# The real-container test: `integration.json` drives a busybox container
# under `celld dev` through the shared example harness. It needs a Docker
# engine (on PATH) and pulls the pinned image the first time, so it is
# labelled `needs-docker`; see README.md.
celld_example(
    name = "integration",
    bindings = {"SANDBOX": "TestSandbox"},
    container_context = "root//src/celld/container/image:image",
    containers = [{
        "class_name": "TestSandbox",
        "image": "container/Dockerfile",
        "instance_type": "dev",
        "max_instances": 2,
    }],
    labels = ["needs-docker"],
    main = "tests/integration/worker.ts",
    script_name = "sandbox-integration",
    spec = "tests/integration/integration.json",
    deps = [":sandbox"],
)

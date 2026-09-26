# SPDX-FileCopyrightText: © 2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

load("@root//buck/shims:shims.bzl", depot = "shims")
load("@toolchains//celld:defs.bzl", "celld")
load(":defs.bzl", "browser_test")

celld.library(
    name = "browser",
    srcs = glob(["src/*.ts"]),
    import_name = "@celld/box/browser",
    visibility = ["PUBLIC"],
    exports = {
        ".": "src/mod.ts",
        "./durable": "src/durable.ts",
    },
    deps = [
        "root//src/celld/box/sandbox:sandbox",
        "root//src/celld/core:core",
    ],
)

[
    celld.test(
        name = suite + "-test",
        srcs = ["tests/" + suite + "_test.ts"],
        fake_runtime = suite == "durable",
        permissions = ["net=127.0.0.1"] if suite != "durable" else [],
        deps = [
            "root//src/celld/core:core",
            ":browser",
        ] + (["root//src/celld/box/container:container"] if suite == "durable" else []),
    )
    for suite in [
        "cdp",
        "fixture",
        "durable",
    ]
]

celld.test(
    name = "bridge-test",
    srcs = [
        "src/bridge.ts",
        "tests/bridge_test.ts",
    ],
    deps = [
        "root//src/celld/core:core",
    ],
)

depot.python_library(
    name = "runner-lib",
    srcs = ["runner.py"],
    base_module = "",
    deps = ["root//src/celld/examples:harness-lib"],
)

depot.python_binary(
    name = "runner-selftest-runner",
    main = "runner_test.py",
    deps = [":runner-lib"],
)

depot.command_test(
    name = "runner-selftest",
    cmd = ["$(exe :runner-selftest-runner)"],
)

depot.python_binary(
    name = "runner",
    main = "runner.py",
    visibility = ["PUBLIC"],
    deps = ["root//src/celld/examples:harness-lib"],
)

celld.worker(
    name = "fixture-worker",
    main = "tests/integration/worker.ts",
    deps = [":browser"],
)

celld.project(
    name = "fixture",
    src = ":fixture-worker",
    bindings = {"BROWSER": "BrowserSandbox"},
    container_context = "root//src/celld/box/browser/image:image",
    containers = [{
        "class_name": "BrowserSandbox",
        "image": "container/Dockerfile",
        "instance_type": "dev",
        "max_instances": 2,
        "runtime": "runsc",
    }],
    script_name = "browser-fixture",
    visibility = ["PUBLIC"],
)

browser_test(
    name = "smoke-test",
    main = "tests/integration/browser_test.ts",
    deps = [
        "root//src/celld/core:core",
        ":browser",
    ],
)

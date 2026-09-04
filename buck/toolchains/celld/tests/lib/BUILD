# SPDX-FileCopyrightText: © 2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

load("@root//buck/shims:shims.bzl", "shims")
load("@toolchains//celld:defs.bzl", "celld")

# A chain of libraries: top imports both of base's entry points, objects
# defines a Durable Object on top of it, and the worker bundles them all.
celld.library(
    name = "base",
    import_name = "@fixture/base",
    exports = {
        ".": "base/mod.ts",
        "./extra": "base/extra.ts",
    },
)

celld.library(
    name = "top",
    srcs = ["top/internal.ts"],
    import_name = "@fixture/top",
    exports = {".": "top/mod.ts"},
    deps = [":base"],
)

celld.library(
    name = "objects",
    import_name = "@fixture/objects",
    exports = {".": "objects/mod.ts"},
    deps = [":top"],
)

celld.worker(
    name = "worker",
    main = "worker/index.ts",
    deps = [
        ":objects",
        ":top",
    ],
)

celld.project(
    name = "project",
    src = ":worker",
    bindings = {"COUNTER": "Counter"},
    script_name = "celld-library-test",
)

celld.deploy_test(
    name = "deploy-test",
    project = ":project",
)

celld.test(
    name = "top-test",
    srcs = ["top/top_test.ts"],
    deps = [
        ":base",
        ":top",
    ],
)

# The Durable Object's module imports "cloudflare:workers"; the fake runtime
# stands in for it so the test can construct the class.
celld.test(
    name = "objects-test",
    srcs = ["objects/objects_test.ts"],
    fake_runtime = True,
    deps = [":objects"],
)

# Units that must fail; graph_test.py writes their manifests itself.
shims.export_file(
    name = "bad",
    src = "bad",
    mode = "reference",
)

shims.python_binary(
    name = "graph-test-runner",
    main = "graph_test.py",
)

shims.command_test(
    name = "graph-test",
    cmd = [
        "$(exe :graph-test-runner)",
        "$(exe toolchains//celld:driver)",
        "$(exe toolchains//celld:deno)",
        "$(location toolchains//celld:types)",
        "$(location toolchains//celld:testing)",
        "$(location :bad)",
    ],
)

shims.test_suite(
    name = "tests",
    tests = [
        ":base[check]",
        ":base[lint]",
        ":deploy-test",
        ":graph-test",
        ":objects-test",
        ":objects[check]",
        ":objects[lint]",
        ":top-test",
        ":top[check]",
        ":top[lint]",
        ":worker[check]",
        ":worker[lint]",
    ],
)

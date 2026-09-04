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

# Depends on base through an alias: the driver's direct-dependency check
# must see the library the alias points at.
shims.alias(
    name = "base-alias",
    actual = ":base",
)

celld.test(
    name = "top-test",
    srcs = ["top/top_test.ts"],
    deps = [
        ":base-alias",
        ":top",
    ],
)

# Declarations only: nothing to lint, and `deno check` has only a .d.ts.
celld.library(
    name = "decls",
    import_name = "@fixture/decls",
    exports = {".": "decls/mod.d.ts"},
)

# Imports a JSON module (`with { type: "json" }`) and a file in a directory
# whose name has a space, which the driver must spell as a file: URL.
celld.library(
    name = "data",
    srcs = [
        "data/sp ace/total.ts",
        "data/table.json",
    ],
    import_name = "@fixture/data",
    exports = {".": "data/mod.ts"},
    deps = [":decls"],
)

# The Durable Object's module imports "cloudflare:workers"; the fake runtime
# stands in for it so the test can construct the class.
celld.test(
    name = "objects-test",
    srcs = ["objects/objects_test.ts"],
    fake_runtime = True,
    deps = [":objects"],
)

# A library whose only file is generated: project.bxl builds it along with
# the fragment, since the editor's import map points into buck-out.
shims.write_file(
    name = "generated.ts",
    contents = [
        "// SPDX-FileCopyrightText: © 2026 Austin Seipp",
        "// SPDX-License-Identifier: Apache-2.0",
        "",
        "/** Written by the build. */",
        "export const GENERATED = 42;",
        "",
    ],
)

celld.library(
    name = "generated",
    import_name = "@fixture/generated",
    exports = {".": ":generated.ts"},
)

# Every `cloudflare:*` module the fake runtime replaces: `env` and RPC from
# cloudflare:workers, NonRetryableError from cloudflare:workflows.
celld.test(
    name = "runtime-test",
    srcs = ["runtime/runtime_test.ts"],
    fake_runtime = True,
    deps = [
        ":data",
        ":generated",
    ],
)

# A library carrying a wasm module: `@fixture/wasm/add` is the compiled
# module under Deno (test) and under celld (the worker, whose project copies
# the file beside the bundle).
shims.python_binary(
    name = "add-wasm-gen",
    main = "wasm/add_wasm.py",
)

shims.genrule(
    name = "add.wasm",
    out = "add.wasm",
    cmd = "$(exe :add-wasm-gen) $OUT",
)

celld.library(
    name = "wasm",
    import_name = "@fixture/wasm",
    wasm = {"./add": ":add.wasm"},
    exports = {".": "wasm/mod.ts"},
)

celld.test(
    name = "wasm-test",
    srcs = ["wasm/wasm_test.ts"],
    deps = [":wasm"],
)

celld.worker(
    name = "wasm-worker",
    main = "wasm/worker.ts",
    deps = [":wasm"],
)

celld.project(
    name = "wasm-project",
    src = ":wasm-worker",
    script_name = "celld-wasm-test",
    visibility = ["toolchains//celld/tests/..."],
)

celld.deploy_test(
    name = "wasm-deploy-test",
    project = ":wasm-project",
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
        "$(exe toolchains//web:driver)",
        "$(exe toolchains//web:deno)",
        "$(exe root//src/tools/web:web)",
        "$(location toolchains//celld:types)",
        "$(location toolchains//celld:testing)",
        "$(location :bad)",
    ],
)

shims.test_suite(
    name = "tests",
    tests = [
        "toolchains//web/tests:native-graph-test",
        ":base[check]",
        ":base[lint]",
        ":data[check]",
        ":data[lint]",
        ":decls[check]",
        ":decls[lint]",
        ":deploy-test",
        ":generated[check]",
        ":generated[lint]",
        ":graph-test",
        ":objects-test",
        ":objects[check]",
        ":objects[lint]",
        ":runtime-test",
        ":top-test",
        ":top[check]",
        ":top[lint]",
        ":wasm-deploy-test",
        ":wasm-test",
        ":wasm-worker[check]",
        ":wasm-worker[lint]",
        ":wasm[check]",
        ":wasm[lint]",
        ":worker[check]",
        ":worker[lint]",
    ],
)

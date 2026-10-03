# SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

load("@root//buck/shims:shims.bzl", "shims")
load("@toolchains//deno:defs.bzl", "deno")
load("@toolchains//js:defs.bzl", "js")
load("@toolchains//web:defs.bzl", "web")

shims.python_binary(
    name = "native-graph-runner",
    main = "native_graph_test.py",
    deps = ["toolchains//web:webc-lib"],
)

shims.command_test(
    name = "native-graph-test",
    cmd = [
        "$(exe :native-graph-runner)",
        "$(exe toolchains//web:native)",
    ],
)

shims.python_binary(
    name = "native-quality-runner",
    main = "native_quality_test.py",
)

shims.command_test(
    name = "native-quality-test",
    cmd = [
        "$(exe :native-quality-runner)",
        "$(location toolchains//web:quality)",
        "$(exe toolchains//web:native)",
        "$(exe toolchains//web:deno)",
        "$(exe toolchains//web:driver)",
    ],
)

shims.python_binary(
    name = "svelte-check-runner",
    main = "svelte_check_test.py",
)

shims.command_test(
    name = "svelte-check-test",
    cmd = [
        "$(exe :svelte-check-runner)",
        "$(exe toolchains//web:driver)",
        "$(exe toolchains//web:deno)",
        "$(exe toolchains//web:native)",
        "$(location toolchains//web/svelte:runtime)",
    ],
)

js.library(
    name = "portable",
    import_name = "@fixture/portable",
    lib = [
        "dom",
        "esnext",
    ],
    exports = {".": "portable.ts"},
)

web.bundle(
    name = "portable-bundle",
    main = "entry.ts",
    minify = True,
    deps = [":portable"],
)

web.quality(
    name = "quality",
    srcs = [
        "entry.ts",
        "portable.ts",
    ],
)

web.svelte_library(
    name = "views",
    import_name = "@fixture/views",
    exports = {".": "Page.svelte"},
)

web.bundle(
    name = "ssr",
    main = "ssr.ts",
    minify = True,
    svelte_runtime = True,
    deps = [":views"],
)

web.browser(
    name = "browser",
    main = "browser.ts",
    minify = True,
    deps = [":views"],
)

deno.run(
    name = "svelte-deno-run",
    src = "svelte_deno.ts",
    srcs = ["ssr.ts"],
    check = True,
    deps = [":views"],
)

deno.test(
    name = "svelte-deno-test",
    srcs = [
        "ssr.ts",
        "svelte_deno_test.ts",
    ],
    deps = [":views"],
)

deno.binary(
    name = "svelte-deno-binary",
    srcs = ["ssr.ts"],
    main = "svelte_deno.ts",
    type = "run",
    deps = [":views"],
)

shims.test_suite(
    name = "tests",
    tests = [
        "root//src/tools/web:tests",
        ":browser[check]",
        ":browser[lint]",
        ":native-graph-test",
        ":native-quality-test",
        ":portable-bundle[check]",
        ":portable-bundle[lint]",
        ":portable[check]",
        ":portable[lint]",
        ":quality",
        ":ssr[check]",
        ":ssr[lint]",
        ":svelte-check-test",
        ":views[check]",
        ":views[lint]",
    ],
    visibility = ["PUBLIC"],
)

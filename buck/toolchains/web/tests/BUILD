# SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

load("@root//buck/shims:shims.bzl", "shims")
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

shims.test_suite(
    name = "tests",
    tests = [
        "toolchains//web/native:tests",
        ":native-graph-test",
        ":native-quality-test",
        ":portable-bundle[check]",
        ":portable-bundle[lint]",
        ":portable[check]",
        ":portable[lint]",
        ":quality",
        ":svelte-check-test",
    ],
    visibility = ["PUBLIC"],
)

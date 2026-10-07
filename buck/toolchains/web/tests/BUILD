# SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

load("@root//buck/shims:shims.bzl", "shims")

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

shims.test_suite(
    name = "tests",
    tests = [
        "toolchains//web/native:tests",
        ":native-graph-test",
        ":native-quality-test",
        ":svelte-check-test",
    ],
    visibility = ["PUBLIC"],
)

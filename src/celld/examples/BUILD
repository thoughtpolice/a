# SPDX-FileCopyrightText: © 2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

load("@root//buck/shims:shims.bzl", depot = "shims")
load("@toolchains//celld:defs.bzl", "celld")
load(":defs.bzl", "celld_example", "celld_example_upstream")

# The host every fake upstream runs in; see upstream.ts.
celld.library(
    name = "upstream",
    import_name = "@celld/examples/upstream",
    visibility = ["PUBLIC"],
    exports = {".": "upstream.ts"},
)

depot.python_library(
    name = "harness-lib",
    srcs = ["harness.py"],
    base_module = "",
)

# The runner `celld_example` gives each example's `-test` and `-dev` targets.
depot.python_binary(
    name = "harness",
    main = "harness.py",
    visibility = ["PUBLIC"],
)

depot.python_binary(
    name = "harness-selftest-runner",
    main = "harness_test.py",
    deps = [":harness-lib"],
)

# The matchers and the SSE parser, including every way they must fail.
depot.command_test(
    name = "harness-selftest",
    cmd = ["$(exe :harness-selftest-runner)"],
)

# The harness's own example: a Worker relaying to an echoing upstream, so a
# change to the harness is tested end to end without any library.
celld_example_upstream(
    name = "echo-upstream",
    main = "testdata/echo_upstream.ts",
    deps = [],
)

celld_example(
    name = "echo",
    kv_namespaces = {"NOTES": "echo-example-notes"},
    main = "testdata/echo.ts",
    spec = "testdata/echo.json",
    upstream = ":echo-upstream",
    deps = [],
)

# The shape of a pure library's examples: no upstream, only a spec.
celld_example(
    name = "plain",
    main = "testdata/plain.ts",
    spec = "testdata/plain.json",
    deps = [],
)

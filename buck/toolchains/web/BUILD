# SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

load("@root//buck/shims:shims.bzl", "shims")
load(":defs.bzl", "web_deno", "web_tool")
load(":toolchain.bzl", "web_toolchain")

shims.python_library(
    name = "webc-lib",
    srcs = [
        "assets.py",
        "imports.py",
        "quality.py",
        "svelte.py",
        "webc.py",
    ],
    base_module = "",
    visibility = ["PUBLIC"],
)

shims.python_binary(
    name = "webc",
    base_module = "",
    main = "webc.py",
    deps = [":webc-lib"],
)

shims.export_file(
    name = "quality",
    src = "quality.py",
    mode = "reference",
    visibility = ["PUBLIC"],
)

web_toolchain(
    name = "web",
    visibility = ["PUBLIC"],
)

web_tool(
    name = "driver",
    tool = "driver",
    visibility = ["PUBLIC"],
)

web_tool(
    name = "native",
    tool = "native",
    visibility = ["PUBLIC"],
)

# Explicit checking/bundling/test backend, not the target JavaScript runtime.
web_deno(
    name = "deno",
    visibility = ["PUBLIC"],
)

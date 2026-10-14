# SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

load("@root//buck/shims:shims.bzl", "shims")
load("@toolchains//deno:defs.bzl", "deno")

deno.binary(
    name = "rtlcc",
    config = "deno.jsonc",
    main = "main.tsx",
    permissions = [
        "read",
        "write",
        "env",
    ],
    type = "run",
    visibility = ["PUBLIC"],
)

# Modules main.tsx imports, which Deno finds on its own, and the CXXRTL demo.
shims.lint_files(
    name = "modules",
    srcs = glob([
        "*.ts",
        "cxxrtl/*",
    ]),
)

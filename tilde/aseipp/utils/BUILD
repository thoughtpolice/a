# SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

load("@toolchains//deno:defs.bzl", "deno")

deno.run(
    name = "ccusage",
    package_id = "npm:ccusage@15.3.1",
    permissions = ["read", "write", "net", "env", "sys"],
)

deno.run(
    name = 'claude-review',
    src = "claude-review.tsx",
    permissions = [
        "all"
    ],
)

deno.run(
    name = 'claude-difftool',
    src = "claude-difftool.ts",
    permissions = [
        "run=claude,diff,rich"
    ]
)

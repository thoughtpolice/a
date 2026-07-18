# SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

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

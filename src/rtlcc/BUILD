# SPDX-FileCopyrightText: © 2024-2025 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

load("@toolchains//deno:defs.bzl", "deno")

deno.binary(
    name="rtlcc",
    main="main.ts",
    type="run",
    config="deno.jsonc",
    permissions=["read", "write", "env"],
    visibility=["PUBLIC"],
)

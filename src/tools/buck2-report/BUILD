# SPDX-FileCopyrightText: © 2024-2025 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

load("@toolchains//deno:defs.bzl", "deno")

deno.binary(
    name="buck2-report",
    main="main.ts",
    type="run",
    permissions=["read", "write"],
    visibility=["PUBLIC"],
)
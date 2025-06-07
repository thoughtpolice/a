# SPDX-FileCopyrightText: © 2024-2025 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

load("@toolchains//deno:defs.bzl", "deno")

deno.binary(
    name="quicktd",
    main="main.ts",
    type="run",
    permissions=["read", "write", "run", "env"],
    visibility=["PUBLIC"],
)
